// Pure Content-Security-Policy reasoning shared by the build audit and its tests.

import { createHash } from "node:crypto";

export function parsePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

export function sourcesFor(directives, directive, fallback) {
  return directives.get(directive) ?? directives.get(fallback) ?? directives.get("default-src") ?? [];
}

export function integrityOf(source) {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

/**
 * Describes how a directive treats inline content. Browsers ignore
 * 'unsafe-inline' as soon as any nonce or hash source is present, so the audit
 * applies that same precedence rather than a looser one.
 */
export function inlineAllowance(sources) {
  const hashes = sources
    .filter((source) => /^'sha(256|384|512)-/i.test(source))
    .map((source) => source.slice(1, -1));
  const hasNonce = sources.some((source) => /^'nonce-/i.test(source));
  const hasUnsafeInline = sources.some((source) => source.toLowerCase() === "'unsafe-inline'");
  return {
    hashes,
    hasNonce,
    allowsAnyInline: hasUnsafeInline && hashes.length === 0 && !hasNonce,
  };
}

export function permitsInline(allowance, { body, attributes = "" }) {
  if (allowance.allowsAnyInline) return true;
  if (allowance.hasNonce && /\bnonce=/i.test(attributes)) return true;
  return allowance.hashes.includes(integrityOf(body));
}

/** Inline scripts that carry data rather than executable code are never run. */
export function isDataScript(attributes) {
  return /\btype=("|')?(application\/json|application\/ld\+json|importmap)/i.test(attributes);
}

export function* inlineScripts(html) {
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (isDataScript(match[1])) continue;
    yield { attributes: match[1], body: match[2] };
  }
}

export function* inlineStyleBlocks(html) {
  for (const match of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
    yield { attributes: match[1], body: match[2] };
  }
}

export function hasInlineStyleAttribute(html) {
  return /<[^>]+\sstyle=("|')/i.test(html);
}

/**
 * Returns every reason the exported HTML would not run under the given policy.
 *
 * A static Next.js export delivers its React payload through inline
 * `self.__next_f.push(...)` scripts. If the policy blocks them the page still
 * renders its server HTML, so the site looks perfect while no event handler is
 * ever attached: buttons and file pickers silently do nothing.
 */
export function auditDocument(policy, html, name = "document") {
  const directives = parsePolicy(policy);
  const scriptAllowance = inlineAllowance(sourcesFor(directives, "script-src-elem", "script-src"));
  const styleBlockAllowance = inlineAllowance(sourcesFor(directives, "style-src-elem", "style-src"));
  const styleAttributeAllowance = inlineAllowance(sourcesFor(directives, "style-src-attr", "style-src"));
  const failures = [];
  let scriptCount = 0;

  for (const script of inlineScripts(html)) {
    scriptCount += 1;
    if (permitsInline(scriptAllowance, script)) continue;
    const preview = script.body.slice(0, 48).replace(/\s+/g, " ");
    failures.push(
      `${name}: an inline <script> (${script.body.length} bytes, starting "${preview}") is blocked by script-src. `
        + "React cannot hydrate, so the page renders but nothing on it responds.",
    );
  }

  for (const block of inlineStyleBlocks(html)) {
    if (permitsInline(styleBlockAllowance, block)) continue;
    failures.push(`${name}: an inline <style> block is blocked by style-src.`);
  }

  if (!styleAttributeAllowance.allowsAnyInline && hasInlineStyleAttribute(html)) {
    failures.push(
      `${name}: inline style attributes are blocked by style-src-attr, so progress bars render at the wrong width.`,
    );
  }

  return { failures, scriptCount };
}

/** Checks the policy allowances this application needs regardless of markup. */
export function auditRuntimeNeeds(policy) {
  const directives = parsePolicy(policy);
  const failures = [];
  if (!sourcesFor(directives, "worker-src", "child-src").includes("'self'")) {
    failures.push("worker-src does not allow 'self', so the private processing worker cannot start.");
  }
  if (!sourcesFor(directives, "script-src", "default-src").includes("'wasm-unsafe-eval'")) {
    failures.push("script-src does not allow 'wasm-unsafe-eval', so ONNX Runtime cannot compile its WebAssembly.");
  }
  if (!sourcesFor(directives, "connect-src", "default-src").includes("https://huggingface.co")) {
    failures.push("connect-src does not allow the pinned model host, so the restoration model cannot download.");
  }
  return failures;
}
