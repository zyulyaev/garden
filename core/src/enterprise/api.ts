/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { got, GotResponse, GotHeaders } from "../util/http"
import { findProjectConfig } from "../config/base"
import { CommandError, ConfigurationError, InternalError, RuntimeError } from "../exceptions"
import { LogEntry } from "../logger/log-entry"
import { gardenEnv } from "../constants"
import { ClientAuthToken } from "../db/entities/client-auth-token"
import { Cookie } from "tough-cookie"
import { add, sub, isAfter } from "date-fns"
import { EventEmitter2 } from "eventemitter2"
import { AuthRedirectServer } from "./auth"

// If a GARDEN_AUTH_TOKEN is present and Garden is NOT running from a workflow runner pod,
// switch to ci-token authentication method.
export const authTokenHeader =
  gardenEnv.GARDEN_AUTH_TOKEN && !gardenEnv.GARDEN_GE_SCHEDULED ? "x-ci-token" : "x-access-auth-token"

export const makeAuthHeader = (clientAuthToken: string) => ({ [authTokenHeader]: clientAuthToken })

const refreshThreshold = 10 // Threshold (in seconds) subtracted to jwt validity when checking if a refresh is needed

export interface ApiFetchParams {
  headers: GotHeaders
  method: "GET" | "POST" | "PUT" | "PATCH" | "HEAD" | "DELETE"
}
export interface AuthTokenResponse {
  token: string
  refreshToken: string
  tokenValidity: number
}

export async function getEnterpriseConfig(currentDirectory: string) {
  // The enterprise API is initialized ahead of the Garden class so we need to find and load the project
  // config here without resolving template strings.
  const projectConfig = await findProjectConfig(currentDirectory)
  if (!projectConfig) {
    throw new CommandError(`Not a project directory (or any of the parent directories): ${currentDirectory}`, {
      currentDirectory,
    })
  }

  const domain = projectConfig.domain
  const projectId = projectConfig.id
  if (!domain || !projectId) {
    return
  }

  return { domain, projectId }
}

/**
 * The Enterprise API client.
 *
 * Can only be initialized if the user is actually logged in. Includes a handful of static helper methods
 * for cases where the user is not logged in (e.g. the login method itself).
 */
export class EnterpriseApi {
  private intervalId: NodeJS.Timer | null
  private log: LogEntry
  private intervalMsec = 4500 // Refresh interval in ms, it needs to be less than refreshThreshold/2
  private apiPrefix = "api"
  public domain: string
  public projectId: string

  constructor(log: LogEntry, enterpriseDomain: string, projectId: string) {
    this.log = log
    this.domain = enterpriseDomain
    this.projectId = projectId
  }

  /**
   * Initialize the Enterprise API.
   *
   * Returns null if the project is not configured for Garden Enterprise or if the user is not logged in.
   */
  static async factory(log: LogEntry, currentDirectory: string) {
    log.debug("Initializing enterprise API client.")

    const config = await getEnterpriseConfig(currentDirectory)
    if (!config) {
      log.debug("Enterprise domain and/or project ID missing. Aborting.")
      return null
    }

    const authToken = await EnterpriseApi.readAuthToken(log)
    if (!authToken) {
      log.debug("User is not logged in. Aborting.")
      return null
    }

    const api = new EnterpriseApi(log, config.domain, config.projectId)
    const tokenIsValid = await api.checkClientAuthToken()

    // Throw if using an invalid access token
    if (gardenEnv.GARDEN_AUTH_TOKEN && !tokenIsValid) {
      throw new RuntimeError(
        "The provided access token is expired or has been revoked, please create a new one from the Garden Enterprise UI.",
        {}
      )
    }

    if (!tokenIsValid) {
      log.debug({ msg: `Current auth token is invalid, refreshing` })
      await api.refreshToken()
    }

    // Start refresh interval if using JWT
    if (!gardenEnv.GARDEN_AUTH_TOKEN) {
      log.debug({ msg: `Starting refresh interval.` })
      api.startInterval()
    }

    return api
  }

  static async saveAuthToken(log: LogEntry, tokenResponse: AuthTokenResponse) {
    try {
      const manager = ClientAuthToken.getConnection().manager
      await manager.transaction(async (transactionalEntityManager) => {
        await transactionalEntityManager.clear(ClientAuthToken)
        await transactionalEntityManager.save(
          ClientAuthToken,
          ClientAuthToken.create({
            token: tokenResponse.token,
            refreshToken: tokenResponse.refreshToken,
            validity: add(new Date(), { seconds: tokenResponse.tokenValidity / 1000 }),
          })
        )
      })
      log.debug("Saved client auth token to local config db")
    } catch (error) {
      log.error(`An error occurred while saving client auth token to local config db:\n${error.message}`)
    }
  }

  /**
   * If a persisted client auth token was found, or if the GARDEN_AUTH_TOKEN environment variable is present,
   * returns it. Returns null otherwise.
   *
   * Note that the GARDEN_AUTH_TOKEN environment variable takes precedence over a persisted auth token if both are
   * present.
   *
   * In the inconsistent/erroneous case of more than one auth token existing in the local store, picks the first auth
   * token and deletes all others.
   */
  static async readAuthToken(log: LogEntry): Promise<string | null> {
    const tokenFromEnv = gardenEnv.GARDEN_AUTH_TOKEN
    if (tokenFromEnv) {
      log.silly("Read client auth token from env")
      return tokenFromEnv
    }

    const [tokens, tokenCount] = await ClientAuthToken.findAndCount()

    const token = tokens[0] ? tokens[0].token : null

    if (tokenCount > 1) {
      log.debug("More than one client auth tokens found, clearing up...")
      try {
        await ClientAuthToken.getConnection()
          .createQueryBuilder()
          .delete()
          .from(ClientAuthToken)
          .where("token != :token", { token })
          .execute()
      } catch (error) {
        log.error(`An error occurred while clearing up duplicate client auth tokens:\n${error.message}`)
      }
    }
    log.silly(`Retrieved client auth token from local config db`)

    return token
  }

  /**
   * If a persisted client auth token exists, deletes it.
   */
  static async clearAuthToken(log: LogEntry) {
    await ClientAuthToken.getConnection().createQueryBuilder().delete().from(ClientAuthToken).execute()
    log.debug("Cleared persisted auth token (if any)")
  }

  static async login(log: LogEntry, currentDirectory: string) {
    const config = await getEnterpriseConfig(currentDirectory)
    if (!config) {
      throw new ConfigurationError(`Project config is missing an enterprise domain and/or a project ID.`, {})
    }

    log.info({ msg: `Logging in to ${config.domain}...` })

    // Start auth redirect server and wait for its redirect handler to receive the redirect and finish running.
    const events = new EventEmitter2()
    const server = new AuthRedirectServer(config.domain, events, log)
    log.debug(`Redirecting to Garden Enterprise login page...`)
    const response: AuthTokenResponse = await new Promise(async (resolve, _reject) => {
      // The server resolves the promise with the new auth token once it's received the redirect.
      await server.start()
      events.once("receivedToken", (tokenResponse: AuthTokenResponse) => {
        log.debug("Received client auth token.")
        resolve(tokenResponse)
      })
    })
    await server.close()
    if (!response) {
      throw new InternalError(`Error: Did not receive an auth token after logging in.`, {})
    }

    await EnterpriseApi.saveAuthToken(log, response)
    return response.token
  }

  private startInterval() {
    this.log.debug({ msg: `Will run refresh function every ${this.intervalMsec} ms.` })
    this.intervalId = setInterval(() => {
      this.refreshToken().catch((err) => {
        this.log.debug({ msg: "Something went wrong while trying to refresh the authentication token." })
        this.log.debug({ msg: err.message })
      })
    }, this.intervalMsec)
  }

  async close() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  async refreshToken() {
    const invalidCredentialsErrorMsg = "Your Garden Enteprise credentials have expired. Please login again."
    const token = await ClientAuthToken.findOne()

    if (!token || gardenEnv.GARDEN_AUTH_TOKEN) {
      this.log.debug({ msg: "Nothing to refresh, returning." })
      return
    }

    if (isAfter(new Date(), sub(token.validity, { seconds: refreshThreshold }))) {
      try {
        const res = await this.get("token/refresh", {
          Cookie: `rt=${token?.refreshToken}`,
        })

        let cookies: any
        if (res.headers["set-cookie"] instanceof Array) {
          cookies = res.headers["set-cookie"].map((cookieStr) => {
            return Cookie.parse(cookieStr)
          })
        } else {
          cookies = [Cookie.parse(res.headers["set-cookie"] || "")]
        }

        const rt = cookies.find((cookie) => cookie.key === "rt")
        const tokenObj = {
          token: res.body.data.jwt,
          refreshToken: rt.value || "",
          tokenValidity: res.body.data.jwtValidity,
        }
        await EnterpriseApi.saveAuthToken(this.log, tokenObj)
      } catch (err) {
        const res = err.response

        if (res && res.statusCode === 401) {
          this.log.debug({ msg: `Failed to refresh the token.` })
          await EnterpriseApi.clearAuthToken(this.log)
          throw new RuntimeError(invalidCredentialsErrorMsg, {})
        } else {
          throw new RuntimeError(
            `An error occurred while verifying client auth token with platform: ${err.message}`,
            {}
          )
        }
      }
    }
  }

  private async apiFetch(path: string, params: ApiFetchParams, body?: any): Promise<GotResponse<any>> {
    const { method, headers } = params
    this.log.silly({ msg: `Fetching enterprise APIs. ${method} ${path}` })
    const token = await EnterpriseApi.readAuthToken(this.log)
    // TODO add more logging details
    const requestObj = {
      method,
      headers: {
        ...headers,
        ...makeAuthHeader(token || ""),
      },
      json: body || undefined,
    }

    const res = await got(`${this.domain}/${this.apiPrefix}/${path}`, {
      ...requestObj,
      responseType: "json",
    })
    return res
  }

  // TODO Validate response
  async get(path: string, headers?: GotHeaders) {
    this.log.debug({ msg: `PATH ${path} headers ${JSON.stringify(headers, null, 2)}` })
    return this.apiFetch(path, {
      headers: headers || {},
      method: "GET",
    })
  }

  async post(path: string, payload: { body?: any; headers?: GotHeaders } = { body: {} }) {
    const { headers, body } = payload
    return this.apiFetch(
      path,
      {
        headers: headers || {},
        method: "POST",
      },
      body
    )
  }

  /**
   * Checks with the backend whether the provided client auth token is valid.
   */
  async checkClientAuthToken(): Promise<boolean> {
    let valid = false
    try {
      this.log.debug(`Checking client auth token with platform: ${this.domain}/token/verify`)
      await this.get("token/verify")
      valid = true
    } catch (err) {
      const res = err.response
      if (res.statusCode === 401) {
        valid = false
      } else {
        throw new RuntimeError(`An error occurred while verifying client auth token with platform: ${err.message}`, {})
      }
    }
    this.log.debug(`Checked client auth token with platform - valid: ${valid}`)
    return valid
  }

  async logout() {
    const token = await ClientAuthToken.findOne()
    if (!token || gardenEnv.GARDEN_AUTH_TOKEN) {
      // Noop when the user is not logged in or an access token is in use
      return
    }
    try {
      await this.post("token/logout", {
        headers: {
          Cookie: `rt=${token?.refreshToken}`,
        },
      })
    } catch (error) {
      this.log.debug({ msg: `An error occurred while logging out from Garden Enterprise: ${error.message}` })
    } finally {
      await EnterpriseApi.clearAuthToken(this.log)
    }
  }
}
