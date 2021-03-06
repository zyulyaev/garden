/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { LogEntry } from "../logger/log-entry"
import { getSecrets } from "./get-secrets"
import { StringMap } from "../config/common"
import { EnterpriseApi } from "./api"

export interface EnterpriseConnectParams {
  log: LogEntry
  environmentName: string
  enterpriseApi: EnterpriseApi
}

// TODO: Did we need the tokenIsValid check?
// TODO: Remove.
export async function enterpriseConnect({ log, environmentName, enterpriseApi }: EnterpriseConnectParams) {
  let success = true
  let secrets: StringMap = {}

  const enterpriseLog = log.info({ section: "garden-enterprise", msg: "Connecting...", status: "active" })

  try {
    secrets = await getSecrets({
      environmentName,
      enterpriseApi,
      log: enterpriseLog,
    })
  } catch (err) {
    success = false
  }

  enterpriseLog.silly(`Fetched ${Object.keys(secrets).length} secrets from ${enterpriseApi.domain}`)

  if (success) {
    enterpriseLog.setSuccess("Ready")
  } else {
    enterpriseLog.setWarn()
  }

  return secrets
}
