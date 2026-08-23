import { Camera, ExternalLink } from "lucide-react";

import { PlatformDownloads } from "@/components/platform-downloads";

const REPOSITORY_URL =
  "https://github.com/jpattison54319/Sony-Cyber-shot-Date-Removal";
const RELEASE_ROOT = `${REPOSITORY_URL}/releases/latest`;

export function DownloadApp() {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Date Stamp Cleaner home">
          <span className="brand-mark" aria-hidden="true">
            <Camera size={18} strokeWidth={2.2} />
          </span>
          <span>Date Stamp Cleaner</span>
        </a>

        <nav aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            GitHub
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="page-title">
          <h1 id="page-title">Remove Sony Cyber‑shot dates.</h1>
          <p className="hero-summary">
            A private desktop app for macOS and Windows.
          </p>
        </section>

        <section className="downloads" id="downloads" aria-labelledby="download-heading">
          <div className="section-heading">
            <h2 id="download-heading">Download</h2>
            <p>Choose your computer.</p>
          </div>

          <PlatformDownloads />

          <aside className="installer-notice" aria-labelledby="installer-note-title">
            <p>
              <strong id="installer-note-title">Unsigned installers</strong>
              macOS or Windows may ask you to confirm before opening the app.
            </p>
            <div className="release-links">
              <a href={RELEASE_ROOT}>Release notes</a>
              <a href={`${RELEASE_ROOT}/download/SHA256SUMS.txt`}>SHA-256 checksums</a>
            </div>
          </aside>
        </section>

        <section className="privacy-section" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading">Private by design</h2>
          <p>
            The restoration model runs locally. There are no accounts, uploads,
            analytics, or photo storage.
          </p>
        </section>

        <section className="how-it-works" id="how-it-works" aria-labelledby="steps-heading">
          <div className="section-heading">
            <h2 id="steps-heading">How it works</h2>
          </div>

          <ol className="steps">
            <li>
              <span className="step-number" aria-hidden="true">1</span>
              <div>
                <h3>Choose photos</h3>
                <p>Select one image or a whole batch.</p>
              </div>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">2</span>
              <div>
                <h3>Remove dates</h3>
                <p>The desktop workflow processes them locally.</p>
              </div>
            </li>
            <li>
              <span className="step-number" aria-hidden="true">3</span>
              <div>
                <h3>Open results</h3>
                <p>Find the verified PNGs in your chosen folder.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="accuracy-note" aria-labelledby="accuracy-heading">
          <h2 id="accuracy-heading">What the app changes</h2>
          <p>
            Date-covered pixels are reconstructed. Pixels outside the timestamp
            mask are verified unchanged, and originals are never overwritten.
          </p>
        </section>
      </main>

      <footer>
        <strong>Date Stamp Cleaner</strong>
        <p>Independent project. Not affiliated with Sony.</p>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
          Source code
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </footer>
    </>
  );
}
