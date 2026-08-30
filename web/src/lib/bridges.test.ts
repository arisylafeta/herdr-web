import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_STORAGE_KEY,
  createBridgeProfile,
  defaultBridgeProfile,
  loadBridgeProfiles,
  saveBridgeProfiles,
} from "./bridges";

describe("bridge profiles", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses short hostnames for built-in and saved device labels", () => {
    const configured = defaultBridgeProfile({ pwaOrigin: "https://crm.example.ts.net:8787" });
    const stored = JSON.stringify([
      {
        id: "home",
        label: "home.example.ts.net",
        baseUrl: "https://home.example.ts.net:8787",
      },
    ]);
    const profiles = loadBridgeProfiles(configured, { getItem: () => stored });
    expect(profiles).toEqual([
      {
        id: "default",
        label: "crm",
        baseUrl: "https://crm.example.ts.net:8787",
        builtIn: true,
      },
      {
        id: "home",
        label: "home",
        baseUrl: "https://home.example.ts.net:8787",
      },
    ]);
  });

  it("can target a separate bridge as the built-in receiver", () => {
    vi.stubEnv("VITE_HERDR_BRIDGE_URL", "https://desktop.example:8787/path");
    vi.stubEnv("VITE_HERDR_BRIDGE_LABEL", "Desktop bridge");
    expect(defaultBridgeProfile({ pwaOrigin: "https://pwa.example" })).toEqual({
      id: "default",
      label: "Desktop bridge",
      baseUrl: "https://desktop.example:8787",
      builtIn: true,
    });
  });

  it("normalizes and persists only remote receivers", () => {
    const setItem = vi.fn();
    const builtIn = defaultBridgeProfile({ pwaOrigin: "https://laptop.example" });
    const desktop = createBridgeProfile("desktop", "Desktop", "https://desktop.example/path");

    saveBridgeProfiles([builtIn, desktop], { setItem });

    expect(setItem).toHaveBeenCalledWith(
      BRIDGE_STORAGE_KEY,
      JSON.stringify([{ id: "desktop", label: "Desktop", baseUrl: "https://desktop.example" }]),
    );
  });

  it("drops malformed, duplicate, and local-origin stored entries", () => {
    const stored = JSON.stringify([
      { id: "desktop", label: "Desktop", baseUrl: "https://desktop.example" },
      { id: "duplicate", label: "Again", baseUrl: "https://desktop.example/path" },
      { id: "default-copy", label: "Laptop", baseUrl: "https://laptop.example" },
      { id: "bad", label: "Bad", baseUrl: "file:///tmp/socket" },
    ]);
    const builtIn = defaultBridgeProfile({ pwaOrigin: "https://laptop.example" });
    const profiles = loadBridgeProfiles(builtIn, { getItem: () => stored });
    expect(profiles.map((profile) => profile.id)).toEqual(["default", "desktop"]);
  });
});
