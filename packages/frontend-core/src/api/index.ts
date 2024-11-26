import {
  HTTPMethod,
  APICallParams,
  APIClientConfig,
  APIClient,
  APICallConfig,
  BaseAPIClient,
} from "./types"
import { Helpers } from "@budibase/bbui"
import { Header } from "@budibase/shared-core"
import { ApiVersion } from "../constants"
import { buildAnalyticsEndpoints } from "./analytics"
import { buildAIEndpoints } from "./ai"
import { buildAppEndpoints } from "./app"
import { buildAttachmentEndpoints } from "./attachments"
import { buildAuthEndpoints } from "./auth"
import { buildAutomationEndpoints } from "./automations"
import { buildConfigEndpoints } from "./configs"
import { buildDatasourceEndpoints } from "./datasources"
import { buildFlagEndpoints } from "./flags"
import { buildHostingEndpoints } from "./hosting"
import { buildLayoutEndpoints } from "./layouts"
import { buildOtherEndpoints } from "./other"
import { buildPermissionsEndpoints } from "./permissions"
import { buildQueryEndpoints } from "./queries"
import { buildRelationshipEndpoints } from "./relationships"
import { buildRoleEndpoints } from "./roles"
import { buildRouteEndpoints } from "./routes"
import { buildRowEndpoints } from "./rows"
import { buildScreenEndpoints } from "./screens"
import { buildTableEndpoints } from "./tables"
import { buildTemplateEndpoints } from "./templates"
import { buildUserEndpoints } from "./user"
import { buildSelfEndpoints } from "./self"
import { buildViewEndpoints } from "./views"
import { buildViewV2Endpoints } from "./viewsV2"
import { buildLicensingEndpoints } from "./licensing"
import { buildGroupsEndpoints } from "./groups"
import { buildPluginEndpoints } from "./plugins"
import { buildBackupsEndpoints } from "./backups"
import { buildEnvironmentVariableEndpoints } from "./environmentVariables"
import { buildEventEndpoints } from "./events"
import { buildAuditLogsEndpoints } from "./auditLogs"
import { buildLogsEndpoints } from "./logs"
import { buildMigrationEndpoints } from "./migrations"
import { buildRowActionEndpoints } from "./rowActions"

/**
 * Random identifier to uniquely identify a session in a tab. This is
 * used to determine the originator of calls to the API, which is in
 * turn used to determine who caused a websocket message to be sent, so
 * that we can ignore events caused by ourselves.
 */
export const APISessionID = Helpers.uuid()

/**
 * Constructs an API client with the provided configuration.
 */
export const createAPIClient = (config: APIClientConfig = {}): APIClient => {
  let cache: Record<string, any> = {}

  // Generates an error object from an API response
  const makeErrorFromResponse = async (
    response: Response,
    method: HTTPMethod,
    suppressErrors = false
  ) => {
    // Try to read a message from the error
    let message = response.statusText
    let json: any = null
    try {
      json = await response.json()
      if (json?.message) {
        message = json.message
      } else if (json?.error) {
        message = json.error
      }
    } catch (error) {
      // Do nothing
    }
    return {
      message,
      json,
      status: response.status,
      url: response.url,
      method,
      handled: true,
      suppressErrors,
    }
  }

  // Generates an error object from a string
  const makeError = (message: string, url?: string, method?: HTTPMethod) => {
    return {
      message,
      json: null,
      status: 400,
      url: url,
      method: method,
      handled: true,
    }
  }

  // Performs an API call to the server.
  const makeApiCall = async <T>(callConfig: APICallConfig): Promise<T> => {
    let { json, method, external, body, url, parseResponse, suppressErrors } =
      callConfig

    // Ensure we don't do JSON processing if sending a GET request
    json = json && method !== HTTPMethod.GET

    // Build headers
    let headers = { Accept: "application/json" }
    headers[Header.SESSION_ID] = APISessionID
    if (!external) {
      headers[Header.API_VER] = ApiVersion
    }
    if (json) {
      headers["Content-Type"] = "application/json"
    }
    if (config?.attachHeaders) {
      config.attachHeaders(headers)
    }

    // Build request body
    let requestBody = body
    if (json) {
      try {
        requestBody = JSON.stringify(body)
      } catch (error) {
        throw makeError("Invalid JSON body", url, method)
      }
    }

    // Make request
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: requestBody,
        credentials: "same-origin",
      })
    } catch (error) {
      delete cache[url]
      throw makeError("Failed to send request", url, method)
    }

    // Handle response
    if (response.status >= 200 && response.status < 400) {
      handleMigrations(response)
      try {
        if (parseResponse) {
          return await parseResponse<T>(response)
        } else {
          return (await response.json()) as T
        }
      } catch (error) {
        delete cache[url]
        throw `Failed to parse response: ${error}`
      }
    } else {
      delete cache[url]
      throw await makeErrorFromResponse(response, method, suppressErrors)
    }
  }

  const handleMigrations = (response: Response) => {
    if (!config.onMigrationDetected) {
      return
    }
    const migration = response.headers.get(Header.MIGRATING_APP)

    if (migration) {
      config.onMigrationDetected(migration)
    }
  }

  // Performs an API call to the server  and caches the response.
  // Future invocation for this URL will return the cached result instead of
  // hitting the server again.
  const makeCachedApiCall = async <T>(
    callConfig: APICallConfig
  ): Promise<T> => {
    const identifier = callConfig.url
    if (!cache[identifier]) {
      cache[identifier] = makeApiCall(callConfig)
      cache[identifier] = await cache[identifier]
    }
    return (await cache[identifier]) as T
  }

  // Constructs an API call function for a particular HTTP method
  const requestApiCall =
    (method: HTTPMethod) =>
    async <T>(params: APICallParams): Promise<T> => {
      try {
        let callConfig: APICallConfig = {
          json: true,
          external: false,
          suppressErrors: false,
          cache: false,
          method,
          ...params,
        }
        let { url, cache, external } = callConfig
        if (!external) {
          callConfig.url = `/${url}`.replace("//", "/")
        }

        // Cache the request if possible and desired
        const cacheRequest = cache && config?.enableCaching
        const handler = cacheRequest ? makeCachedApiCall : makeApiCall
        return await handler<T>(callConfig)
      } catch (error) {
        if (config?.onError) {
          config.onError(error)
        }
        throw error
      }
    }

  // Build the underlying core API methods
  let API: BaseAPIClient = {
    post: requestApiCall(HTTPMethod.POST),
    get: requestApiCall(HTTPMethod.GET),
    patch: requestApiCall(HTTPMethod.PATCH),
    delete: requestApiCall(HTTPMethod.DELETE),
    put: requestApiCall(HTTPMethod.PUT),
    error: (message: string) => {
      throw makeError(message)
    },
    invalidateCache: () => {
      cache = {}
    },

    // Generic utility to extract the current app ID. Assumes that any client
    // that exists in an app context will be attaching our app ID header.
    getAppID: (): string => {
      let headers = {}
      config?.attachHeaders?.(headers)
      return headers?.[Header.APP_ID]
    },
  }

  // Attach all endpoints
  return {
    ...API,
    ...buildAIEndpoints(API),
    ...buildAnalyticsEndpoints(API),
    ...buildAppEndpoints(API),
    ...buildAttachmentEndpoints(API),
    ...buildAuthEndpoints(API),
    ...buildAutomationEndpoints(API),
    ...buildConfigEndpoints(API),
    ...buildDatasourceEndpoints(API),
    ...buildFlagEndpoints(API),
    ...buildHostingEndpoints(API),
    ...buildLayoutEndpoints(API),
    ...buildOtherEndpoints(API),
    ...buildPermissionsEndpoints(API),
    ...buildQueryEndpoints(API),
    ...buildRelationshipEndpoints(API),
    ...buildRoleEndpoints(API),
    ...buildRouteEndpoints(API),
    ...buildRowEndpoints(API),
    ...buildScreenEndpoints(API),
    ...buildTableEndpoints(API),
    ...buildTemplateEndpoints(API),
    ...buildUserEndpoints(API),
    ...buildViewEndpoints(API),
    ...buildSelfEndpoints(API),
    ...buildLicensingEndpoints(API),
    ...buildGroupsEndpoints(API),
    ...buildPluginEndpoints(API),
    ...buildBackupsEndpoints(API),
    ...buildEnvironmentVariableEndpoints(API),
    ...buildEventEndpoints(API),
    ...buildAuditLogsEndpoints(API),
    ...buildLogsEndpoints(API),
    ...buildMigrationEndpoints(API),
    viewV2: buildViewV2Endpoints(API),
    rowActions: buildRowActionEndpoints(API),
  }
}
