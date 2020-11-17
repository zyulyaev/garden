/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { findProjectConfig } from "../config/base"
import { CommandError, ConfigurationError } from "../exceptions"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { readAuthToken, saveAuthToken } from "./auth"

export class EnterpriseApi {
  private intervalId: NodeJS.Timer | null
  protected log: LogEntry
  protected enterpriseDomain: string
  protected intervalMsec = 5000

  constructor(log: LogEntry) {
    this.log = log
  }

  async init(currentDirectory: string) {
    // TODO: Extract logic for finding domain into helper, and reuse that in the body of the login command.
    const projectConfig = await findProjectConfig(currentDirectory)
    if (!projectConfig) {
      throw new CommandError(`Not a project directory (or any of the parent directories): ${currentDirectory}`, {
        currentDirectory,
      })
    }
    const enterpriseDomain = projectConfig.domain
    if (!enterpriseDomain) {
      return
    }
    this.enterpriseDomain = enterpriseDomain

    await this.updateToken()
    this.startInterval()
  }

  startInterval() {
    this.intervalId = setInterval(() => {
      this.updateToken().catch((err) => {
        this.log.error(err)
      })
    }, this.intervalMsec)
  }

  async updateToken() {
    const authToken = await readAuthToken(this.log)
    const updatedToken = await updateAuthToken(this.log, this.enterpriseDomain, authToken)
    await saveAuthToken(updatedToken, this.log)
  }
}
