"use client";

import { useEffect, useMemo, useState } from "react";
import {
  arcTestnetLiveProof,
  arcTestnetLiveProofItems,
  publicDemoScenarios,
  type DemoScenarioId
} from "../lib/scenarios";

type DemoConfig = {
  mode: "live" | "mock";
  chain: string;
  chainId: number;
  explorerUrl: string;
  usdcAddress: string;
  memoAddress: string;
  registryAddress: string;
  accessCodeRequired: boolean;
};

type DemoOutput = {
  mode: "live" | "mock";
  scenarioId: DemoScenarioId;
  expectedOutcome: string;
  result: {
    state: "not_executed" | "settled";
    reason?: string;
    replayed?: boolean;
    decisionCommitment?: string;
    decision: {
      outcome: string;
      reason: string;
      recordIdHash?: string;
    };
    anchor?: { txHash: string; blockNumber: string } | null;
    settlement?: { txHash: string; blockNumber: string; amountMinor: string; memoId: string };
  };
};

const scenarioOrder: DemoScenarioId[] = ["allow", "approval", "block"];

export default function ArcDemoPage() {
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("allow");
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [output, setOutput] = useState<DemoOutput | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const scenario = publicDemoScenarios[scenarioId];

  useEffect(() => {
    fetch("/api/config", { cache: "no-store" })
      .then(async (response) => response.json() as Promise<DemoConfig>)
      .then(setConfig)
      .catch(() => setError("Unable to load the Arc interaction configuration."));
  }, []);

  useEffect(() => {
    setOutput(null);
    setError("");
  }, [scenarioId]);

  const live = config?.mode === "live";
  const outcomeTone = useMemo(() => {
    const outcome = output?.result.decision.outcome ?? scenario.expectedOutcome;
    return outcome === "allow" ? "good" : outcome === "block" ? "bad" : "warn";
  }, [output, scenario.expectedOutcome]);

  async function runScenario() {
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accessCode ? { "x-demo-access-code": accessCode } : {})
        },
        body: JSON.stringify({ scenarioId })
      });
      const body = await response.json() as DemoOutput | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Demo execution failed");
      setOutput(body as DemoOutput);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Demo execution failed");
    } finally {
      setRunning(false);
    }
  }

  function startFreshRun() {
    setOutput(null);
    setError("");
  }

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="#top" aria-label="Coffer Arc home">
          <span className="brand-mark">C</span>
          <span>Coffer</span>
        </a>
        <div className="nav-status">
          <span className={`pulse ${live ? "live" : "mock"}`} />
          {live ? "ACCESS-CONTROLLED LIVE RUN" : "LIVE PROOF · SAFE SIMULATION"}
        </div>
        <a className="nav-link" href="#live-proof">Arc proof</a>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow">PROGRAMMABLE MONEY FOR THE AGENTIC ECONOMY</div>
          <h1>Agents can spend.<br /><em>Now they can be accountable.</em></h1>
          <p className="hero-lede">
            Coffer decides whether an AI agent may spend before Circle signs anything—then binds the approved decision to USDC settlement on Arc.
          </p>
          <div className="hero-tags">
            <span>Verified live proof</span><span>Arc Testnet</span><span>USDC-native gas</span><span>Transaction Memo</span>
          </div>
        </div>
        <div className="hero-proof">
          <span className="proof-label">THE CONTROL ORDER</span>
          <ol>
            <li><b>01</b><span>Agent asks to spend</span></li>
            <li><b>02</b><span>Coffer evaluates policy</span></li>
            <li><b>03</b><span>Approved commitment anchors on Arc</span></li>
            <li><b>04</b><span>Circle EOA settles USDC with Memo</span></li>
            <li><b>05</b><span>Onchain evidence returns to the SDR</span></li>
          </ol>
        </div>
      </section>

      <section className="live-proof-section shell" id="live-proof">
        <div className="section-head">
          <div>
            <span className="section-index">01 / VERIFIED ONCHAIN EVIDENCE</span>
            <h2>Inspect the completed run on Arc.</h2>
          </div>
          <p>These are public ArcScan records from one verified Arc Testnet run. No API key, wallet credential, or live-write switch is needed to inspect them.</p>
        </div>

        <div className="proof-boundary-grid" aria-label="Live proof and simulation boundary">
          <div className="proof-boundary live-evidence">
            <span>REAL ONCHAIN EVIDENCE</span>
            <strong>Completed before this page loads</strong>
            <p>The Registry, deployment, decision anchor, and 0.01 USDC settlement below are immutable public chain records.</p>
          </div>
          <div className="proof-boundary safe-interaction">
            <span>FIXED-SCENARIO SIMULATION</span>
            <strong>Interactive, synthetic, and separate</strong>
            <p>The panel in Section 02 explains allow, approval, and block behavior without replaying these transactions or exposing wallet credentials.</p>
          </div>
        </div>

        <div className="live-proof-grid">
          {arcTestnetLiveProofItems.map((item) => (
            <a
              aria-label={`Open ${item.label} on ArcScan`}
              className="live-proof-card"
              href={item.href}
              key={item.label}
              rel="noreferrer"
              target="_blank"
            >
              <span>{item.eyebrow}</span>
              <strong>{item.label}</strong>
              <code title={item.value}>{shortHash(item.value, 10)}</code>
              <p>{item.detail}</p>
              <b>VIEW ON ARCSCAN ↗</b>
            </a>
          ))}
        </div>
        <p className="proof-timestamp">Evidence verified from public Arc data · {formatProofDate(arcTestnetLiveProof.verifiedAt)} · Chain ID {arcTestnetLiveProof.chainId}</p>
      </section>

      <section className="demo-section shell">
        <div className="section-head">
          <div>
            <span className="section-index">02 / FIXED-SCENARIO INTERACTION</span>
            <h2>{live ? "Run the access-controlled flow" : "Replay the policy flow safely"}</h2>
          </div>
          <p>{live ? "Only three synthetic scenarios are accepted. Recipient and amount are fixed server-side." : "This interactive walkthrough is simulated. It does not submit a Circle request, Arc transaction, or hosted Coffer write."}</p>
        </div>

        <div className={`interaction-boundary ${live ? "live" : "simulated"}`}>
          <span>{live ? "ACCESS-CONTROLLED LIVE MODE" : "SIMULATION MODE"}</span>
          <p>{live ? "Live execution is separately access-controlled and uses fixed server-side scenario IDs with replay protection." : "Synthetic inputs only. The real onchain evidence remains independently available in Section 01."}</p>
        </div>

        <div className="scenario-grid">
          {scenarioOrder.map((id) => {
            const item = publicDemoScenarios[id];
            return (
              <button
                className={`scenario-card ${scenarioId === id ? "selected" : ""}`}
                key={id}
                onClick={() => setScenarioId(id)}
                type="button"
              >
                <span className={`scenario-dot ${id}`} />
                <small>{item.eyebrow}</small>
                <strong>{item.title}</strong>
                <span className="scenario-route">{item.amount} → {item.vendorName}</span>
                <p>{item.description}</p>
              </button>
            );
          })}
        </div>

        <div className="execution-grid">
          <article className="request-panel">
            <div className="panel-title"><span>SPEND INTENT</span><code>hackathon-v1</code></div>
            <dl>
              <div><dt>Agent</dt><dd>External Research Agent</dd></div>
              <div><dt>Vendor</dt><dd>{scenario.vendorName}</dd></div>
              <div><dt>Amount</dt><dd className="amount">{scenario.amount} USDC</dd></div>
              <div><dt>Network</dt><dd>Arc Testnet · 5042002</dd></div>
              <div><dt>Purpose</dt><dd>{scenario.intent.businessPurpose}</dd></div>
            </dl>
            {config?.accessCodeRequired ? (
              <label className="access-field">
                <span>Judge access code</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setAccessCode(event.target.value)}
                  placeholder="Provided in submission notes"
                  type="password"
                  value={accessCode}
                />
              </label>
            ) : null}
            <button className="run-button" disabled={running || !config} onClick={runScenario} type="button">
              {running ? <><span className="spinner" /> Verifying flow…</> : <>{live ? "Run controlled spend" : "Run safe simulation"} <span>→</span></>}
            </button>
            <p className="safety-copy">
              {live ? "One fixed run per scenario. Replays cannot create a second payment." : "Simulation only. No hosted data, wallet call, or funds."}
            </p>
          </article>

          <article className={`result-panel ${outcomeTone}`}>
            <div className="panel-title"><span>DECISION + EVIDENCE</span><code>{output ? output.mode.toUpperCase() : "WAITING"}</code></div>
            {!output && !error ? (
              <div className="empty-result">
                <div className="radar"><span /></div>
                <strong>Ready for a spend intent</strong>
                <p>The wallet remains untouched until Coffer returns <code>allow</code>.</p>
              </div>
            ) : null}
            {error ? (
              <div className="error-result">
                <span>EXECUTION PAUSED</span>
                <strong>{error}</strong>
                <p>Retry uses the same run ID to prevent duplicate settlement.</p>
              </div>
            ) : null}
            {output ? <ResultEvidence output={output} explorerUrl={config?.explorerUrl ?? ""} live={live} /> : null}
            {output ? <button className="fresh-button" onClick={startFreshRun} type="button">{live ? "Replay this verified run" : "Start a fresh run"}</button> : null}
          </article>
        </div>
      </section>

      <section className="architecture shell" id="architecture">
        <div className="section-head">
          <div><span className="section-index">03 / ARCHITECTURE</span><h2>Public proof. Private intelligence.</h2></div>
          <p>The repo exposes enough to reproduce and audit Arc settlement—not enough to clone Coffer.</p>
        </div>
        <div className="boundary-grid">
          <article className="boundary private">
            <span>PRIVATE COFFER CONTROL PLANE</span>
            <h3>How the decision is made</h3>
            <ul>
              <li>Policy and risk engine</li><li>Concurrent budgets</li><li>Human approvals and RBAC</li><li>Ledger, audit, and evidence retention</li>
            </ul>
          </article>
          <div className="boundary-arrow"><span>ALLOW ONLY</span><b>→</b></div>
          <article className="boundary public">
            <span>PUBLIC ARC INTEGRATION</span>
            <h3>How the decision is proven</h3>
            <ul>
              <li>Opaque decision commitment</li><li>Immutable registry anchor</li><li>Memo-bound USDC transfer</li><li>Strict receipt and event verification</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="chain-strip">
        <div className="shell chain-grid">
          <div><span>CHAIN</span><strong>{config?.chain ?? "Arc Testnet"}</strong></div>
          <div><span>USDC</span><code>{shortHash(config?.usdcAddress)}</code></div>
          <div><span>MEMO</span><code>{shortHash(config?.memoAddress)}</code></div>
          <div><span>REGISTRY</span><code>{shortHash(config?.registryAddress ?? arcTestnetLiveProof.registry.value)}</code></div>
          <div><span>INTERACTION</span><strong>{live ? "ACCESS CONTROLLED" : "SIMULATED"}</strong></div>
        </div>
      </section>

      <footer className="shell">
        <div className="brand"><span className="brand-mark">C</span><span>Coffer × Arc</span></div>
        <p>Verified Arc Testnet proof · Fixed-scenario interaction · Non-custodial control layer</p>
      </footer>
    </main>
  );
}

function ResultEvidence({ output, explorerUrl, live }: { output: DemoOutput; explorerUrl: string; live: boolean }) {
  const { result } = output;
  const settled = result.state === "settled";
  return (
    <div className="evidence-result">
      <div className="decision-banner">
        <span className={`decision-icon ${result.decision.outcome}`}>{result.decision.outcome === "allow" ? "✓" : result.decision.outcome === "block" ? "×" : "!"}</span>
        <div><small>COFFER DECISION</small><strong>{result.decision.outcome.replaceAll("_", " ")}</strong><p>{result.decision.reason}</p></div>
      </div>
      <div className="evidence-list">
        {result.decision.recordIdHash ? <EvidenceRow label="Spend Decision Record ID hash" value={result.decision.recordIdHash} status="verified" /> : null}
        {result.decisionCommitment ? <EvidenceRow label="Decision commitment" value={result.decisionCommitment} status="verified" /> : null}
        {result.anchor ? (
          <EvidenceRow href={live ? txUrl(explorerUrl, result.anchor.txHash) : undefined} label="Registry anchor" value={result.anchor.txHash} status={live ? "onchain" : "simulated"} />
        ) : null}
        {result.settlement ? (
          <>
            <EvidenceRow href={live ? txUrl(explorerUrl, result.settlement.txHash) : undefined} label="Memo + USDC transaction" value={result.settlement.txHash} status={live ? "onchain" : "simulated"} />
            <EvidenceRow label="Memo ID" value={result.settlement.memoId} status="matched" />
          </>
        ) : (
          <EvidenceRow label="Vendor settlement" value="No USDC transfer submitted" status="not executed" />
        )}
      </div>
      <div className={`final-state ${settled ? "settled" : "stopped"}`}>
        <span>{settled ? (live ? "VERIFIED ON ARC" : "SIMULATED SUCCESS") : "WALLET NOT CALLED"}</span>
        <strong>{settled ? `${result.replayed ? "Original" : "Approved"} settlement linked to the decision` : "Payment stopped before execution"}</strong>
      </div>
    </div>
  );
}

function EvidenceRow({ label, value, status, href }: { label: string; value: string; status: string; href?: string }) {
  return (
    <div className="evidence-row">
      <div><span>{label}</span><code title={value}>{shortHash(value, 12)}</code></div>
      {href ? <a href={href} rel="noreferrer" target="_blank">{status} ↗</a> : <b>{status}</b>}
    </div>
  );
}

function shortHash(value: string | null | undefined, size = 8): string {
  if (!value) return "loading configuration";
  if (value.length <= size * 2 + 3) return value;
  return `${value.slice(0, size + 2)}…${value.slice(-size)}`;
}

function txUrl(explorerUrl: string, txHash: string): string {
  return `${explorerUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

function formatProofDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric"
  }).format(new Date(value));
}
