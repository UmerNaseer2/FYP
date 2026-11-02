/**
 * @jest-environment jsdom
 */
// The browser's half of phone alerts, with stand-ins for the browser's push
// objects. A real subscription needs a real browser and a push service, so this
// looks at the decisions: what state the device is in, and what the server is told.
import {
  keepDeviceOnFile,
  readAlertsState,
  sendTestAlert,
  turnAlertsOff,
  turnAlertsOn,
} from "@/lib/phone-push-client";

jest.mock("../lib/api-fetch", () => ({
  apiFetch: (...args: unknown[]) => (globalThis as unknown as { apiFetchStub: (...a: unknown[]) => unknown }).apiFetchStub(...args),
}));

// The key is "AQID" in base64url: the three bytes 1, 2 and 3.
const SERVER_KEY = "AQID";
const SAME_KEY_BYTES = new Uint8Array([1, 2, 3]).buffer;
const OLD_KEY_BYTES = new Uint8Array([9, 9, 9]).buffer;
const ENDPOINT = "https://push.example.test/device";

type Sent = { url: string; method: string; body: unknown };

let sent: Sent[];
let answers: Record<string, { status?: number; body: unknown }>;
let subscription: ReturnType<typeof fakeSubscription> | null;
let subscribe: jest.Mock;
let requestPermission: jest.Mock;

function fakeSubscription(key: ArrayBuffer | null) {
  return {
    endpoint: ENDPOINT,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: jest.fn(async () => true),
  };
}

function installBrowser({
  permission = "default",
  userAgent = "Android",
  standalone = false,
}: { permission?: string; userAgent?: string; standalone?: boolean } = {}) {
  subscribe = jest.fn(async () => (subscription = fakeSubscription(SAME_KEY_BYTES)));
  const registration = {
    pushManager: { getSubscription: async () => subscription, subscribe },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: jest.fn(async () => registration),
      getRegistration: jest.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
  Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
  requestPermission = jest.fn(async () => "granted");
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: Object.assign(function Notification() {}, { permission, requestPermission }),
  });
}

beforeEach(() => {
  sent = [];
  subscription = null;
  answers = {
    "GET /api/phone/push": { body: { publicKey: SERVER_KEY, available: true } },
    "POST /api/phone/push": { body: { ok: true } },
    "DELETE /api/phone/push": { body: { ok: true } },
    "POST /api/phone/push/test": { body: { sent: 1, failed: 0 } },
  };
  (globalThis as unknown as { apiFetchStub: unknown }).apiFetchStub = async (
    url: string,
    init?: RequestInit
  ) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${url}`];
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  };
  installBrowser();
});

afterEach(() => {
  for (const name of ["PushManager", "Notification"]) {
    delete (window as unknown as Record<string, unknown>)[name];
  }
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe("readAlertsState", () => {
  test("a browser with no push is unsupported, and asks the server nothing", async () => {
    delete (window as unknown as Record<string, unknown>).PushManager;
    await expect(readAlertsState()).resolves.toBe("unsupported");
    expect(sent).toEqual([]);
  });

  test("an iPhone in a browser tab has to install first", async () => {
    installBrowser({ userAgent: "iPhone" });
    await expect(readAlertsState()).resolves.toBe("needs-install");
  });

  test("an iPhone from the Home Screen goes on as normal", async () => {
    installBrowser({ userAgent: "iPhone", standalone: true });
    await expect(readAlertsState()).resolves.toBe("off");
  });

  test("a site with no account to file a device under is unavailable", async () => {
    answers["GET /api/phone/push"] = { body: { publicKey: SERVER_KEY, available: false } };
    await expect(readAlertsState()).resolves.toBe("unavailable");
  });

  test("a device that said no reads as denied", async () => {
    installBrowser({ permission: "denied" });
    await expect(readAlertsState()).resolves.toBe("denied");
  });

  test("no subscription reads as off", async () => {
    await expect(readAlertsState()).resolves.toBe("off");
  });

  test("a subscription with the current key reads as on, and goes to the server again", async () => {
    subscription = fakeSubscription(SAME_KEY_BYTES);
    await expect(readAlertsState()).resolves.toBe("on");
    expect(sent.at(-1)).toEqual({
      url: "/api/phone/push",
      method: "POST",
      body: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
    });
  });

  test("a subscription with an old key is dropped, since nothing could reach it", async () => {
    const held = fakeSubscription(OLD_KEY_BYTES);
    subscription = held;
    await expect(readAlertsState()).resolves.toBe("off");
    expect(held.unsubscribe).toHaveBeenCalled();
    expect(sent.some((call) => call.method === "POST")).toBe(false);
  });

  test("a failed read of the settings uses the server's sentence", async () => {
    answers["GET /api/phone/push"] = { status: 500, body: { error: "Could not read the alert settings." } };
    await expect(readAlertsState()).rejects.toThrow("Could not read the alert settings.");
  });
});

describe("keepDeviceOnFile", () => {
  test("does nothing until the person has said yes, so it never prompts", async () => {
    await keepDeviceOnFile();
    expect(sent).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test("sends the subscription again once they have", async () => {
    installBrowser({ permission: "granted" });
    subscription = fakeSubscription(SAME_KEY_BYTES);
    await keepDeviceOnFile();
    expect(sent.some((call) => call.method === "POST")).toBe(true);
  });
});

describe("turnAlertsOn", () => {
  test("subscribes with the server's key and files the device", async () => {
    await expect(turnAlertsOn()).resolves.toBe("on");
    const options = subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey)).toEqual([1, 2, 3]);
    expect(sent.at(-1)?.method).toBe("POST");
  });

  test("a no stays a no and subscribes to nothing", async () => {
    requestPermission.mockResolvedValue("denied");
    await expect(turnAlertsOn()).resolves.toBe("denied");
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("closing the prompt leaves alerts off", async () => {
    requestPermission.mockResolvedValue("default");
    await expect(turnAlertsOn()).resolves.toBe("off");
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("a failed save undoes the subscription, so it never claims to be on", async () => {
    answers["POST /api/phone/push"] = { status: 409, body: { error: "Alerts need a signed-in account." } };
    await expect(turnAlertsOn()).rejects.toThrow("Alerts need a signed-in account.");
    expect(subscription?.unsubscribe).toHaveBeenCalled();
  });
});

describe("turnAlertsOff", () => {
  test("tells the server, with the address only in the body, then unsubscribes", async () => {
    const held = fakeSubscription(SAME_KEY_BYTES);
    subscription = held;
    await turnAlertsOff();
    expect(sent).toEqual([{ url: "/api/phone/push", method: "DELETE", body: { endpoint: ENDPOINT } }]);
    expect(held.unsubscribe).toHaveBeenCalled();
  });

  test("still unsubscribes when the server cannot be reached", async () => {
    const held = fakeSubscription(SAME_KEY_BYTES);
    subscription = held;
    (globalThis as unknown as { apiFetchStub: unknown }).apiFetchStub = async () => {
      throw new Error("offline");
    };
    await turnAlertsOff();
    expect(held.unsubscribe).toHaveBeenCalled();
  });

  test("with nothing held there is nothing to tell", async () => {
    await turnAlertsOff();
    expect(sent).toEqual([]);
  });
});

test("sendTestAlert says how many were reached", async () => {
  await expect(sendTestAlert()).resolves.toEqual({ sent: 1, failed: 0 });
  answers["POST /api/phone/push/test"] = { status: 500, body: { error: "Could not send a test alert." } };
  await expect(sendTestAlert()).rejects.toThrow("Could not send a test alert.");
});
