/**
 * Signs the person in with Microsoft, the way Microsoft asks desktop apps
 * to: in their own web browser, with PKCE (a one-time secret the app makes
 * for each sign-in), so the installer carries no client secret that someone
 * could copy out of it.
 *
 * A sign-in goes like this:
 *  1. The app opens Microsoft's sign-in page in the person's web browser.
 *  2. They sign in there, and Microsoft sends the browser back to a local
 *     address on this computer (loopback-server.ts) with a one-time code.
 *  3. The app trades the code for an ID token, which says who the person
 *     is, and a refresh token, which lets it ask again later without the
 *     browser.
 *  4. The ID token goes to the server's "desktop" sign-in (see
 *     my-app/lib/desktop-sign-in.ts), which checks it and sets the same
 *     session cookie the web version uses.
 *
 * The refresh token stays in auth.json, locked with the login keyring. Every
 * few hours, and when the computer wakes up, the app uses it to ask Microsoft
 * whether the sign-in still stands (recheck). When Microsoft says it has
 * ended (the account was disabled, say, or its password changed), the person
 * is signed out. When Microsoft cannot be reached, nothing changes for up to
 * 30 days, which is what lets the app work offline (see src/core/offline.ts).
 *
 * MSAL, Microsoft's own library, does the protocol work. This file decides
 * what each outcome means for the person.
 */
import { net, shell } from "electron";
import {
  CryptoProvider,
  InteractionRequiredAuthError,
  LogLevel,
  PromptValue,
  PublicClientApplication,
  ResponseMode,
  ServerError,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";

import type { BuildConfig } from "../core/build-config";
import { describeAuthError, microsoftDescription } from "../core/loopback";
import type { RecheckOutcome } from "../core/offline";
import type { AuthState } from "../core/secrets-file";
import type { SignInResult } from "../shared/ipc";
import { logError, logInfo, logWarn } from "./log";
import { LoopbackServer, type LoopbackResult } from "./loopback-server";
import { ElectronNetworkClient } from "./net-client";

/**
 * Who the person is, plus a refresh token to ask again later. Nothing that
 * reaches their mail, their files or anything else in Microsoft 365.
 */
const SCOPES = ["openid", "profile", "email", "offline_access"];

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** Microsoft's answers that mean the saved sign-in has ended for good. */
const ENDED_CODES = new Set(["invalid_grant", "interaction_required", "login_required", "consent_required"]);

const MESSAGES = {
  notConfigured:
    "Sign-in is not set up in this copy of Schema Studio, because it was built without the Microsoft Entra IDs it signs in with.",
  offline: "Schema Studio could not reach Microsoft. Check that this computer is online, then try again.",
  browser:
    "Schema Studio could not open your web browser for the sign-in. Check that Ubuntu has a default web browser, then try again.",
  timeout: "The sign-in took longer than 10 minutes, so it was stopped. Try again.",
  failed: "The sign-in did not finish. Try again, or open the app's log from Help > Open Logs.",
  cancelled: "The sign-in was cancelled.",
};

export type AuthOptions = {
  /** The Microsoft Entra IDs the app was built with. */
  config: BuildConfig;
  /** The saved sign-in, from auth.json. */
  state: AuthState;
  /** Saves the sign-in to auth.json. Throws when it cannot. */
  save(state: AuthState): void;
  /** Brings the app's window to the front, once the browser part is over. */
  focusWindow(): void;
};

type SilentOutcome = { kind: "ok"; idToken: string | null } | { kind: "ended" | "offline" | "unavailable" };

export class Auth {
  /** False when the app was built without the Microsoft Entra IDs, so it cannot sign in at all. */
  readonly configured: boolean;
  private readonly options: AuthOptions;
  private readonly state: AuthState;
  private readonly network = new ElectronNetworkClient();
  private readonly crypto = new CryptoProvider();
  private readonly client: PublicClientApplication | null;
  /** The sign-in under way, which Cancel stops. */
  private attempt: AbortController | null = null;

  constructor(options: AuthOptions) {
    this.options = options;
    this.state = { ...options.state };
    const { clientId, tenantId } = options.config;
    if (clientId === null || tenantId === null) {
      this.configured = false;
      this.client = null;
      return;
    }
    this.configured = true;

    // MSAL keeps its tokens in memory and asks before and after each use;
    // this keeps auth.json in step with it.
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (context: TokenCacheContext) => {
        try {
          // "{}" rather than nothing when no sign-in is saved: it empties
          // what MSAL holds, so memory always matches auth.json and nothing
          // is left behind after a sign-out.
          context.tokenCache.deserialize(this.state.msalCache ?? "{}");
        } catch (error) {
          logWarn("The saved Microsoft sign-in could not be read, so it was forgotten.", error);
          try {
            context.tokenCache.deserialize("{}");
          } catch {
            // Nothing more to forget.
          }
          this.state.msalCache = null;
          this.persist();
        }
      },
      afterCacheAccess: async (context: TokenCacheContext) => {
        if (!context.cacheHasChanged) return;
        this.state.msalCache = context.tokenCache.serialize();
        this.persist();
      },
    };

    this.client = new PublicClientApplication({
      auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
      cache: { cachePlugin },
      system: {
        loggerOptions: {
          loggerCallback: (level, message, containsPii) => {
            if (containsPii) return;
            if (level === LogLevel.Error) logError(`Microsoft sign-in: ${message}`);
            else logWarn(`Microsoft sign-in: ${message}`);
          },
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
        },
        networkClient: this.network,
      },
    });
  }

  /** Saves the sign-in to auth.json. A failed save is logged: the sign-in still works until the app quits. */
  private persist(): void {
    try {
      this.options.save({ ...this.state });
    } catch (error) {
      logError("Could not save the Microsoft sign-in.", error);
    }
  }

  /** Notes that Microsoft confirmed the sign-in just now, which restarts the 30 days the app works offline. */
  private markOnline(): void {
    this.state.lastOnlineCheck = Date.now();
    this.persist();
  }

  /** When Microsoft last confirmed the sign-in, or null if it never has. */
  lastOnlineCheck(): number | null {
    return this.state.lastOnlineCheck;
  }

  private async account(client: PublicClientApplication): Promise<AccountInfo | null> {
    const accounts = await client.getTokenCache().getAllAccounts();
    return accounts[0] ?? null;
  }

  /** True when a sign-in is saved, whether or not Microsoft still accepts it. */
  async hasAccount(): Promise<boolean> {
    if (this.client === null) return false;
    try {
      return (await this.account(this.client)) !== null;
    } catch (error) {
      logWarn("Could not read the saved Microsoft sign-in.", error);
      return false;
    }
  }

  /**
   * Signs in: with the saved sign-in while Microsoft still accepts it, and
   * otherwise in the web browser. Never rejects; every outcome is a
   * SignInResult the sign-in page can show.
   */
  async signIn(): Promise<SignInResult> {
    const { client } = this;
    if (client === null) return { ok: false, reason: "failed", message: MESSAGES.notConfigured };
    // Pressing Sign in again starts over.
    this.attempt?.abort();
    const attempt = new AbortController();
    this.attempt = attempt;
    try {
      return await this.runSignIn(client, attempt.signal);
    } catch (error) {
      logError("The Microsoft sign-in failed.", error);
      return { ok: false, reason: "failed", message: MESSAGES.failed };
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  private async runSignIn(client: PublicClientApplication, signal: AbortSignal): Promise<SignInResult> {
    // A saved sign-in that Microsoft still accepts needs no browser.
    let saved: AccountInfo | null = null;
    try {
      saved = await this.account(client);
    } catch (error) {
      logWarn("Could not read the saved Microsoft sign-in.", error);
    }
    if (saved !== null) {
      const silent = await this.trySilent(client, saved);
      if (signal.aborted) return this.cancelled();
      if (silent.kind === "ok" && silent.idToken !== null) return { ok: true, idToken: silent.idToken };
      if (silent.kind === "offline") return { ok: false, reason: "offline", message: MESSAGES.offline };
      if (silent.kind === "ended") await this.removeAllAccounts(client);
    }
    if (signal.aborted) return this.cancelled();

    const { verifier, challenge } = await this.crypto.generatePkceCodes();
    const state = this.crypto.createNewGuid();
    const nonce = this.crypto.createNewGuid();
    const before = this.network.transportFailures;

    const loopback = await LoopbackServer.open(state);
    try {
      const { redirectUri } = loopback;

      let url: string;
      try {
        url = await client.getAuthCodeUrl({
          scopes: SCOPES,
          redirectUri,
          responseMode: ResponseMode.FORM_POST,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          state,
          nonce,
          prompt: PromptValue.SELECT_ACCOUNT,
        });
      } catch (error) {
        // Making the address asks Microsoft where its sign-in pages are.
        if (this.isOffline(before)) {
          logWarn("Could not reach Microsoft to start the sign-in.", error);
          return { ok: false, reason: "offline", message: MESSAGES.offline };
        }
        logError("Could not make the Microsoft sign-in address.", error);
        return { ok: false, reason: "failed", message: MESSAGES.failed };
      }
      if (signal.aborted) return this.cancelled();

      try {
        await shell.openExternal(url);
      } catch (error) {
        // The address itself is never logged: it carries the sign-in's state.
        logError("Could not open the web browser for the sign-in.", error);
        return { ok: false, reason: "failed", message: MESSAGES.browser };
      }

      const timeout = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
      let result: LoopbackResult;
      try {
        result = await loopback.waitForResult(AbortSignal.any([signal, timeout]));
      } catch (error) {
        if (signal.aborted) {
          logInfo("The Microsoft sign-in was cancelled in Schema Studio.");
          return this.cancelled();
        }
        if (timeout.aborted) {
          logWarn("The Microsoft sign-in took longer than 10 minutes, so it was stopped.");
          return { ok: false, reason: "failed", message: MESSAGES.timeout };
        }
        throw error;
      }

      if (result.kind === "error") {
        const described = describeAuthError({ error: result.error, description: result.description });
        if (described.reason === "cancelled") logInfo("The Microsoft sign-in was cancelled in the web browser.");
        else logWarn(`The Microsoft sign-in did not finish: ${described.message}`);
        this.options.focusWindow();
        return { ok: false, ...described };
      }

      let tokens: AuthenticationResult;
      try {
        // MSAL checks that the answer's state is this sign-in's, and that
        // the ID token carries this sign-in's nonce (taken from the request).
        tokens = await client.acquireTokenByCode(
          { code: result.code, scopes: SCOPES, redirectUri, codeVerifier: verifier, state, nonce },
          { code: result.code, state, ...(result.clientInfo !== null ? { client_info: result.clientInfo } : {}) },
        );
        if (!tokens.idToken) throw new Error("Microsoft's answer had no ID token.");
      } catch (error) {
        loopback.finish("failed");
        this.options.focusWindow();
        return this.exchangeFailed(error, before);
      }

      loopback.finish("signed-in");
      this.options.focusWindow();
      this.markOnline();
      // One person per copy of the app: an older account is forgotten.
      if (tokens.account) await this.removeOtherAccounts(client, tokens.account.homeAccountId);
      logInfo("Signed in with Microsoft.");
      return { ok: true, idToken: tokens.idToken };
    } finally {
      loopback.close();
    }
  }

  private exchangeFailed(error: unknown, before: number): SignInResult {
    if (this.isOffline(before)) {
      logWarn("Lost the connection to Microsoft while finishing the sign-in.", error);
      return { ok: false, reason: "offline", message: MESSAGES.offline };
    }
    if (error instanceof ServerError || error instanceof InteractionRequiredAuthError) {
      const described = describeAuthError({
        error: error.errorCode,
        description: microsoftDescription(error.errorMessage),
      });
      logWarn(`Microsoft did not accept the sign-in: ${described.message}`);
      return { ok: false, ...described };
    }
    logError("Could not finish the Microsoft sign-in.", error);
    return { ok: false, reason: "failed", message: MESSAGES.failed };
  }

  /** Asks Microsoft for fresh tokens with the saved sign-in, without the browser. */
  private async trySilent(client: PublicClientApplication, account: AccountInfo): Promise<SilentOutcome> {
    const before = this.network.transportFailures;
    try {
      // Always fresh from Microsoft: the server accepts only ID tokens under
      // 10 minutes old, and asking Microsoft is the check itself.
      const tokens = await client.acquireTokenSilent({ account, scopes: SCOPES, forceRefresh: true });
      this.markOnline();
      if (!tokens.idToken) logWarn("Microsoft accepted the saved sign-in but sent no ID token.");
      return { kind: "ok", idToken: tokens.idToken || null };
    } catch (error) {
      const kind = this.classify(error, before);
      if (kind === "ended") logWarn("Microsoft says this sign-in has ended, so you need to sign in again.", error);
      else if (kind === "offline") logInfo("Could not reach Microsoft to check the sign-in.");
      else logWarn("Microsoft could not check the sign-in.", error);
      return { kind };
    }
  }

  private classify(error: unknown, before: number): "ended" | "offline" | "unavailable" {
    if (error instanceof InteractionRequiredAuthError) return "ended";
    if (error instanceof ServerError && ENDED_CODES.has(error.errorCode)) return "ended";
    if (this.isOffline(before)) return "offline";
    return "unavailable";
  }

  /** True when a request since `before` got no answer from Microsoft, or the computer says it is offline. */
  private isOffline(before: number): boolean {
    return this.network.transportFailures > before || !net.isOnline();
  }

  /**
   * Asks Microsoft whether the saved sign-in still stands. Gives "offline"
   * when Microsoft has not answered within `timeoutMs`, so a slow network
   * never holds the app up.
   */
  async recheck(timeoutMs = 30_000): Promise<RecheckOutcome> {
    const { client } = this;
    if (client === null) return "unavailable";
    let account: AccountInfo | null;
    try {
      account = await this.account(client);
    } catch (error) {
      logWarn("Could not read the saved Microsoft sign-in.", error);
      return "unavailable";
    }
    if (account === null) return "ended";

    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<RecheckOutcome>((resolve) => {
      timer = setTimeout(() => {
        logInfo("Microsoft did not answer the sign-in check in time.");
        resolve("offline");
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.trySilent(client, account).then((outcome) => outcome.kind), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops the sign-in under way, if there is one. */
  cancelSignIn(): void {
    this.attempt?.abort();
  }

  /**
   * Forgets the Microsoft sign-in on this computer. The person's own sign-in
   * to Microsoft in their web browser is theirs, so it is left alone.
   */
  async signOut(): Promise<void> {
    this.cancelSignIn();
    if (this.client !== null) await this.removeAllAccounts(this.client);
    this.state.msalCache = null;
    this.state.lastOnlineCheck = null;
    this.persist();
  }

  private async removeAllAccounts(client: PublicClientApplication): Promise<void> {
    try {
      const cache = client.getTokenCache();
      for (const account of await cache.getAllAccounts()) await cache.removeAccount(account);
    } catch (error) {
      logWarn("Could not remove the saved Microsoft sign-in.", error);
    }
  }

  private async removeOtherAccounts(client: PublicClientApplication, keep: string): Promise<void> {
    try {
      const cache = client.getTokenCache();
      for (const account of await cache.getAllAccounts()) {
        if (account.homeAccountId !== keep) await cache.removeAccount(account);
      }
    } catch (error) {
      logWarn("Could not remove an older Microsoft sign-in.", error);
    }
  }

  private cancelled(): SignInResult {
    return { ok: false, reason: "cancelled", message: MESSAGES.cancelled };
  }
}
