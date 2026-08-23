"use client";

import { Apple, Download, Monitor } from "lucide-react";
import { useSyncExternalStore } from "react";

type Platform = "macos" | "windows" | "other";

const RELEASE_ROOT =
  "https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal/releases/latest/download";
const MAC_ARM_URL = `${RELEASE_ROOT}/DateStampCleaner-macOS-Apple-Silicon.dmg`;
const MAC_INTEL_URL = `${RELEASE_ROOT}/DateStampCleaner-macOS-Intel.dmg`;
const WINDOWS_URL = `${RELEASE_ROOT}/DateStampCleaner-Windows-x64-Setup.exe`;

function subscribeToPlatform(): () => void {
  return () => undefined;
}

export function detectPlatform(userAgentValue: string, platformValue: string): Platform {
  const userAgent = userAgentValue.toLowerCase();
  const platform = platformValue.toLowerCase();
  if (
    userAgent.includes("iphone") ||
    userAgent.includes("ipad") ||
    userAgent.includes("android") ||
    userAgent.includes("mobile")
  ) {
    return "other";
  }
  if (userAgent.includes("windows") || platform.startsWith("win")) return "windows";
  if (userAgent.includes("mac") || platform.startsWith("mac")) return "macos";
  return "other";
}

function platformSnapshot(): Platform {
  return detectPlatform(navigator.userAgent, navigator.platform);
}

function serverPlatformSnapshot(): Platform {
  return "other";
}

export function PlatformDownloads() {
  const platform = useSyncExternalStore(
    subscribeToPlatform,
    platformSnapshot,
    serverPlatformSnapshot,
  );

  return (
    <div className="download-grid">
      <section
        className={`platform-option ${platform === "macos" ? "recommended" : ""}`}
        aria-labelledby="macos-heading"
      >
        <div className="platform-heading">
          <Apple size={25} aria-hidden="true" />
          <div>
            <h3 id="macos-heading">macOS</h3>
            <p>macOS 15 or later</p>
          </div>
          {platform === "macos" ? (
            <span className="device-match">Recommended for this device</span>
          ) : null}
        </div>

        <div className="platform-actions">
          <a className="download-button" href={MAC_ARM_URL}>
            <Download size={17} aria-hidden="true" />
            Apple Silicon
          </a>
          <a className="secondary-button" href={MAC_INTEL_URL}>
            Intel Mac
          </a>
        </div>
      </section>

      <section
        className={`platform-option ${platform === "windows" ? "recommended" : ""}`}
        aria-labelledby="windows-heading"
      >
        <div className="platform-heading">
          <Monitor size={25} aria-hidden="true" />
          <div>
            <h3 id="windows-heading">Windows</h3>
            <p>Windows 10 or 11, 64-bit</p>
          </div>
          {platform === "windows" ? (
            <span className="device-match">Recommended for this device</span>
          ) : null}
        </div>

        <div className="platform-actions single-action">
          <a className="download-button" href={WINDOWS_URL}>
            <Download size={17} aria-hidden="true" />
            Download for Windows
          </a>
        </div>
      </section>
    </div>
  );
}
