"use client";

import { Apple, ChevronRight, Download, Laptop } from "lucide-react";
import { useSyncExternalStore } from "react";

type Platform = "macos" | "windows" | "other";

const RELEASE_ROOT = "https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal/releases/latest/download";
const MAC_ARM_URL = `${RELEASE_ROOT}/DateStampCleaner-macOS-Apple-Silicon.dmg`;
const MAC_INTEL_URL = `${RELEASE_ROOT}/DateStampCleaner-macOS-Intel.dmg`;
const WINDOWS_URL = `${RELEASE_ROOT}/DateStampCleaner-Windows-x64-Setup.exe`;

function subscribeToPlatform(): () => void {
  return () => undefined;
}

function platformSnapshot(): Platform {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();
  if (userAgent.includes("windows") || platform.startsWith("win")) return "windows";
  if (userAgent.includes("mac") || platform.startsWith("mac")) return "macos";
  return "other";
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
    <>
      <div className={`platform-option ${platform === "macos" ? "recommended" : ""}`}>
        <div className="platform-heading">
          <span className="platform-symbol"><Apple size={21} /></span>
          <div><strong>macOS</strong><span>macOS 15 or newer</span></div>
          {platform === "macos" ? <span className="recommended-label">THIS DEVICE</span> : null}
        </div>
        <div className="mac-downloads">
          <a className="download-button" href={MAC_ARM_URL}>
            <Download size={17} /><span><strong>Apple Silicon</strong><small>M1, M2, M3, M4 or newer</small></span>
          </a>
          <a className="secondary-download" href={MAC_INTEL_URL}>
            Intel Mac <ChevronRight size={15} />
          </a>
        </div>
      </div>

      <div className={`platform-option ${platform === "windows" ? "recommended" : ""}`}>
        <div className="platform-heading">
          <span className="platform-symbol"><Laptop size={21} /></span>
          <div><strong>Windows</strong><span>Windows 10 or 11 · 64-bit</span></div>
          {platform === "windows" ? <span className="recommended-label">THIS DEVICE</span> : null}
        </div>
        <a className="download-button" href={WINDOWS_URL}>
          <Download size={17} /><span><strong>Download for Windows</strong><small>Standard setup installer</small></span>
        </a>
      </div>
    </>
  );
}
