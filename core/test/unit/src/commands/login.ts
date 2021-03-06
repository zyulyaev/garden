/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import td from "testdouble"
import { withDefaultGlobalOpts, expectError, getDataDir, cleanupAuthTokens, getLogMessages } from "../../../helpers"
import { AuthRedirectServer } from "../../../../src/enterprise/auth"

import { LoginCommand } from "../../../../src/commands/login"
import stripAnsi from "strip-ansi"
import { makeDummyGarden } from "../../../../src/cli/cli"
import { Garden } from "../../../../src"
import { ClientAuthToken } from "../../../../src/db/entities/client-auth-token"
import { randomString } from "../../../../src/util/string"
import { EnterpriseApi } from "../../../../src/enterprise/api"
import { LogLevel } from "../../../../src/logger/log-node"

function makeCommandParams(garden: Garden) {
  const log = garden.log
  return {
    garden,
    log,
    headerLog: log,
    footerLog: log,
    args: {},
    opts: withDefaultGlobalOpts({}),
  }
}

// In the tests below we stub out the auth redirect server but still emit the
// token received event.
describe("LoginCommand", () => {
  beforeEach(async () => {
    await cleanupAuthTokens()
    td.replace(AuthRedirectServer.prototype, "start", async () => {})
    td.replace(AuthRedirectServer.prototype, "close", async () => {})
  })

  after(async () => {
    await cleanupAuthTokens()
  })

  it("should log in if the project has a domain and an id", async () => {
    const postfix = randomString()
    const testToken = {
      token: `dummy-token-${postfix}`,
      refreshToken: `dummy-refresh-token-${postfix}`,
      tokenValidity: 60,
    }
    const command = new LoginCommand()
    const garden = await makeDummyGarden(getDataDir("test-projects", "login", "has-domain-and-id"), {
      noEnterprise: false,
      commandInfo: { name: "foo", args: {}, opts: {} },
    })

    setTimeout(() => {
      garden.events.emit("receivedToken", testToken)
    }, 500)

    await command.action(makeCommandParams(garden))

    const savedToken = await ClientAuthToken.findOne()
    expect(savedToken).to.exist
    expect(savedToken!.token).to.eql(testToken.token)
    expect(savedToken!.refreshToken).to.eql(testToken.refreshToken)
  })

  it("should be a no-op if the user is already logged in", async () => {
    const postfix = randomString()
    const testToken = {
      token: `dummy-token-${postfix}`,
      refreshToken: `dummy-refresh-token-${postfix}`,
      tokenValidity: 60,
    }

    const command = new LoginCommand()
    const garden = await makeDummyGarden(getDataDir("test-projects", "login", "has-domain-and-id"), {
      noEnterprise: false,
      commandInfo: { name: "foo", args: {}, opts: {} },
    })

    // Save dummy token and mock the validity check so that it returns true
    await EnterpriseApi.saveAuthToken(garden.log, testToken)
    td.replace(EnterpriseApi.prototype, "checkClientAuthToken", async () => true)
    td.replace(EnterpriseApi.prototype, "startInterval", async () => {})

    await command.action(makeCommandParams(garden))

    const savedToken = await ClientAuthToken.findOne()
    expect(savedToken).to.exist
    expect(savedToken!.token).to.eql(testToken.token)
    expect(savedToken!.refreshToken).to.eql(testToken.refreshToken)

    const logOutput = getLogMessages(garden.log, (entry) => entry.level === LogLevel.info).join("\n")

    expect(logOutput).to.include("You're already logged in to Garden Enteprise.")
  })

  // TODO: Should it?
  it.skip("should log in if the project has a domain but no id", async () => {
    const command = new LoginCommand()
    const garden = await makeDummyGarden(getDataDir("test-projects", "login", "has-domain"), {
      noEnterprise: false,
      commandInfo: { name: "foo", args: {}, opts: {} },
    })

    await command.action(makeCommandParams(garden))
  })

  it("should throw if the project doesn't have a domain", async () => {
    const garden = await makeDummyGarden(getDataDir("test-projects", "login", "missing-domain"), {
      commandInfo: { name: "foo", args: {}, opts: {} },
    })
    const command = new LoginCommand()
    await expectError(
      () => command.action(makeCommandParams(garden)),
      (err) =>
        expect(stripAnsi(err.message)).to.match(/Project config is missing an enterprise domain and\/or a project ID./)
    )
  })

  it("should log in if the project config uses secrets in project variables", async () => {
    const postfix = randomString()
    const testToken = {
      token: `dummy-token-${postfix}`,
      refreshToken: `dummy-refresh-token-${postfix}`,
      tokenValidity: 60,
    }
    const command = new LoginCommand()
    const garden = await makeDummyGarden(getDataDir("test-projects", "login", "secret-in-project-variables"), {
      noEnterprise: false,
      commandInfo: { name: "foo", args: {}, opts: {} },
    })

    setTimeout(() => {
      garden.events.emit("receivedToken", testToken)
    }, 500)

    await command.action(makeCommandParams(garden))
    const savedToken = await ClientAuthToken.findOne()
    expect(savedToken).to.exist
    expect(savedToken!.token).to.eql(testToken.token)
    expect(savedToken!.refreshToken).to.eql(testToken.refreshToken)
  })
})
