import {
  Camera,
  Check,
  Code2,
  FolderOpen,
  Images,
  LockKeyhole,
  MonitorDown,
  ShieldCheck,
} from "lucide-react";

import { PlatformDownloads } from "@/components/platform-downloads";

const RELEASE_ROOT = "https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal/releases/latest/download";
const CHECKSUM_URL = `${RELEASE_ROOT}/SHA256SUMS.txt`;

export function DownloadApp() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Date Stamp Cleaner home">
          <span className="brand-mark" aria-hidden="true"><Camera size={19} /></span>
          <span>Date Stamp Cleaner</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#downloads">Download</a>
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer">
            <Code2 size={16} /> Source
          </a>
        </nav>
        <span className="local-badge"><LockKeyhole size={15} /> Fully local</span>
      </header>

      <section className="download-hero" id="top">
        <div className="hero-copy-block">
          <span className="eyebrow">NATIVE MAC + WINDOWS APP</span>
          <h1>The original workflow.<br /><span>On your desktop.</span></h1>
          <p>Add one photo or a whole batch. The validated Python workflow runs locally and keeps your originals untouched.</p>
          <div className="hero-proof" aria-label="Application benefits">
            <span><Check size={15} /> Model included</span>
            <span><Check size={15} /> No uploads</span>
            <span><Check size={15} /> Lossless PNG</span>
          </div>
        </div>

        <section className="download-card" id="downloads" aria-labelledby="download-heading">
          <div className="download-card-heading">
            <span className="download-icon" aria-hidden="true"><MonitorDown size={23} /></span>
            <div>
              <span className="card-kicker">DOWNLOAD</span>
              <h2 id="download-heading">Choose your computer</h2>
            </div>
          </div>

          <PlatformDownloads />

          <a className="checksum-link" href={CHECKSUM_URL}>SHA-256 checksums</a>
        </section>
      </section>

      <section className="trust-banner" aria-label="Privacy summary">
        <ShieldCheck size={22} />
        <div><strong>Your photos stay on your computer.</strong><span>No accounts. No analytics. No photo storage.</span></div>
      </section>

      <section className="desktop-steps" id="how-it-works" aria-labelledby="steps-heading">
        <div className="section-heading">
          <span className="eyebrow">SIMPLE BY DESIGN</span>
          <h2 id="steps-heading">Choose. Clean. Open results.</h2>
        </div>
        <div className="step-grid">
          <article><span className="step-icon"><Images size={22} /></span><h3>Add photos</h3><p>Drag, drop, or multi-select.</p></article>
          <article><span className="step-icon"><Camera size={22} /></span><h3>Remove dates</h3><p>The original LaMa workflow runs locally.</p></article>
          <article><span className="step-icon"><FolderOpen size={22} /></span><h3>Open results</h3><p>Verified PNGs, masks, and reports.</p></article>
        </div>
      </section>

      <section className="honesty-card">
        <div><span className="eyebrow">WHAT “REMOVED” MEANS</span><h2>Reconstructed, never falsely recovered.</h2></div>
        <p>The date-covered area is rebuilt. Every decoded RGB pixel outside its measured mask is verified unchanged.</p>
      </section>

      <footer>
        <div className="footer-brand"><span className="brand-mark"><Camera size={18} /></span><strong>Date Stamp Cleaner</strong></div>
        <p>Independent project. Not affiliated with Sony.</p>
        <a href="https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal" target="_blank" rel="noreferrer"><Code2 size={16} /> GitHub</a>
      </footer>
    </main>
  );
}
