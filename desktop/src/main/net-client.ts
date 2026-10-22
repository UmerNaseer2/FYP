/**
 * How the Microsoft sign-in reaches Microsoft.
 *
 * MSAL, the library that does the sign-in's protocol work, normally uses
 * Node.js's own networking. This hands it Electron's instead, which is
 * Chromium's: requests then go through the proxy Ubuntu is set to use and
 * trust the certificates Ubuntu trusts, as the person's web browser does,
 * which matters on a company or university network.
 *
 * It also keeps two promises. It only ever talks to login.microsoftonline.com.
 * And it counts the requests that got no answer from Microsoft at all, so
 * the app can tell "this computer is offline" apart from "Microsoft said no".
 */
import { session, type Session } from "electron";
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";

import { logWarn } from "./log";

const MICROSOFT = "https://login.microsoftonline.com";
const DEFAULT_TIMEOUT_MS = 30_000;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class ElectronNetworkClient implements INetworkModule {
  /** Requests that got no answer from Microsoft: no connection, no answer in time, or an answer that was not Microsoft's. */
  transportFailures = 0;
  private ses: Session | null = null;
  private readonly refused = new Set<string>();

  /**
   * A session of its own that lives in memory only, so the sign-in's
   * requests share no cookies with the app's windows and leave nothing on
   * disk. It is made on first use, because Electron makes sessions only once
   * the app is ready.
   */
  private session(): Session {
    this.ses ??= session.fromPartition("msal");
    return this.ses;
  }

  sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    return this.send<T>("GET", url, options, timeout);
  }

  sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
    return this.send<T>("POST", url, options);
  }

  private async send<T>(
    method: "GET" | "POST",
    url: string,
    options: NetworkRequestOptions | undefined,
    timeout?: number,
  ): Promise<NetworkResponse<T>> {
    if (originOf(url) !== MICROSOFT) {
      const place = originOf(url) ?? "an address that could not be read";
      if (!this.refused.has(place)) {
        this.refused.add(place);
        logWarn(`Stopped the Microsoft sign-in from contacting ${place}. It only talks to ${MICROSOFT}.`);
      }
      // Not a network failure, so it is not counted as one.
      throw new Error(`The sign-in may not contact ${place}.`);
    }

    let answer: { status: number; headers: Record<string, string>; text: string };
    try {
      const response = await this.session().fetch(url, {
        method,
        headers: options?.headers,
        body: method === "POST" ? options?.body : undefined,
        // Microsoft's sign-in service answers directly. A redirect would come
        // from something in between, such as a hotel Wi-Fi login page.
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout ?? DEFAULT_TIMEOUT_MS),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      answer = { status: response.status, headers, text: await response.text() };
    } catch (error) {
      this.transportFailures++;
      throw error;
    }

    let body: T;
    try {
      body = JSON.parse(answer.text) as T;
    } catch {
      // Microsoft always answers in JSON. Anything else came from something
      // in between (a hotel Wi-Fi page, say) or from an outage.
      this.transportFailures++;
      throw new Error(`The answer to the sign-in (HTTP ${answer.status}) was not from Microsoft's sign-in service.`);
    }
    return { headers: answer.headers, body, status: answer.status };
  }
}
