import { useEffect, useState } from "react";
import { cancelRun, followRun, getRun } from "./api.js";
import { EMPTY_VISUAL, isRunning, reduceVisual, type VisualState } from "./progress.js";
import { elapsedText, historyRow, isModifiedClick, relativeTime, waitText, type HistoryRow } from "./run-list.js";
import { Notice, Spinner, StateBlock, StatusChip } from "./rules.js";
import { RunView } from "./run-view.js";
import type { Server } from "./server.js";

/**
 * The History tab: the shared render line, then every run as a table; a row (or a `?run=<id>` link) opens the run
 * in place — the same RunView the Validate tab shows, nothing is uploaded.
 */

const MAX_LISTED_QUEUE = 6;

export interface HistoryViewProps {
  server: Server;
  /** The run on screen, from the URL; null lists every run. */
  runId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
}

export function HistoryView({ server, runId, onOpen, onBack }: HistoryViewProps) {
  const rows = server.runs.map((run) => historyRow(run, server.now));
  return (
    <div className="history">
      <QueueStrip server={server} />
      {runId ? (
        <RunDetail key={runId} id={runId} server={server} row={rows.find((row) => row.id === runId)} onBack={onBack} />
      ) : (
        <RunTable rows={rows} known={server.known} loaded={server.runsLoaded} owner={server.owner} onOpen={onOpen} />
      )}
    </div>
  );
}

function QueueStrip({ server }: { server: Server }) {
  const { queue, now } = server;
  if (!queue || (queue.running.length === 0 && queue.waiting.length === 0)) return null;
  const wait = waitText(queue.averageRunMs === null ? null : (queue.waiting.length * queue.averageRunMs) / queue.maxConcurrentRuns);
  return (
    <section className="eui-panel queue-strip" aria-label="Server activity">
      <div className="eui-panel-head">
        <div className="eui-head-text">
          <span className="eui-overline">Run server</span>
          <span className="eui-title">Rendering now</span>
        </div>
        <span className="head-meta">{queue.running.length} of {queue.maxConcurrentRuns} slots</span>
      </div>
      <div className="eui-panel-body queue-body">
        <ul className="queue-list">
          {queue.running.map((entry, i) => (
            <li key={entry.id ?? `running-${i}`} className={entry.mine ? "mine" : ""}>
              <Spinner size="xs" decorative />
              <span className="queue-name">{entry.mine ? entry.name : "Another curator's item"}</span>
              {entry.mine && <span className="eui-ds-chip primary xs"><span className="txt">you</span></span>}
              <span className="queue-time">{elapsedText(entry.since, now)}</span>
            </li>
          ))}
          {queue.running.length === 0 && <li className="queue-empty">Nothing — the next item starts right away</li>}
        </ul>
        {queue.waiting.length > 0 && (
          <>
            <span className="eui-home-flabel queue-head">Waiting line · {queue.waiting.length}{wait ? ` · ${wait}` : ""}</span>
            <ol className="queue-list">
              {queue.waiting.slice(0, MAX_LISTED_QUEUE).map((entry, i) => (
                <li key={entry.id ?? `waiting-${i}`} className={entry.mine ? "mine" : ""}>
                  <span className="queue-pos">#{entry.position}</span>
                  <span className="queue-name">{entry.mine ? entry.name : "Another curator's item"}</span>
                  {entry.mine && <span className="eui-ds-chip primary xs"><span className="txt">you</span></span>}
                  <span className="queue-time">waiting {elapsedText(entry.since, now)}</span>
                </li>
              ))}
              {queue.waiting.length > MAX_LISTED_QUEUE && <li className="queue-empty">and {queue.waiting.length - MAX_LISTED_QUEUE} more</li>}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function RunTable({ rows, known, loaded, owner, onOpen }: { rows: HistoryRow[]; known: boolean; loaded: boolean; owner: string | null; onOpen: (id: string) => void }) {
  // the local server calls everyone an operator, so "Sent by" only earns its column when a listed run is someone else's
  const withOwner = rows.some((row) => row.sentBy !== undefined && row.sentBy !== owner);
  return (
    <section className="eui-panel history-card">
      <div className="eui-panel-head">
        <div className="eui-head-text">
          <span className="eui-overline">History</span>
          <span className="eui-title">{withOwner ? "Every curator's runs" : "Your runs"}</span>
        </div>
        {rows.length > 0 && <span className="head-meta">{rows.length} {rows.length === 1 ? "run" : "runs"}</span>}
      </div>
      {known && !loaded ? (
        <div className="eui-panel-body history-empty">
          <div className="eui-file-skel" aria-busy="true" aria-label="Loading runs">
            {[0, 1, 2].map((i) => (
              <div key={i} className="row">
                <span className="b ic" />
                <span className="b ln" style={{ flex: 1 }} />
              </div>
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="eui-panel-body history-empty">
          <StateBlock icon="◌" headline={known ? "No runs yet" : "No run server"} note={known ? "Validate an item to see it here." : "Runs appear here once a run server is connected."} />
        </div>
      ) : (
        <div className="table-scroll">
          <table className="eui-ops-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                {withOwner && <th scope="col">Sent by</th>}
                <th scope="col">When</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="eui-ops-row"
                  onClick={(e) => {
                    if (isModifiedClick(e)) return;
                    onOpen(row.id);
                  }}
                >
                  <td className="cell-name">
                    <a
                      href={`/?run=${encodeURIComponent(row.id)}`}
                      onClick={(e) => {
                        if (isModifiedClick(e)) return;
                        e.preventDefault();
                        onOpen(row.id);
                      }}
                    >
                      {row.name}
                    </a>
                  </td>
                  {withOwner && <td className="cell-owner">{row.sentBy ?? "—"}</td>}
                  <td className="cell-when">
                    <time dateTime={row.startedAt > 0 ? new Date(row.startedAt).toISOString() : undefined}>{row.when}</time>
                  </td>
                  <td className="cell-status">
                    <StatusChip status={row.chip.status} label={row.chip.label} busy={row.live} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface Opened {
  name: string;
  owner?: string;
}

/** A run replayed from the server: every event it stored streams again, then live ones if it is still going. */
function RunDetail({ id, server, row, onBack }: { id: string; server: Server; row: HistoryRow | undefined; onBack: () => void }) {
  const [opened, setOpened] = useState<Opened | null>(row ? { name: row.name, ...(row.sentBy ? { owner: row.sentBy } : {}) } : null);
  const [error, setError] = useState<string | null>(null);
  // the id is seeded, not streamed: the thumbnail figure keys on it and no server event carries it
  const [state, setState] = useState<VisualState>({ ...EMPTY_VISUAL, id });

  useEffect(() => {
    let alive = true;
    void getRun(id).then(
      (run) => alive && setOpened({ name: run.name, ...(run.owner ? { owner: run.owner } : {}) }),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : "This run could not be opened.")
    );
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (error) return;
    setState({ ...EMPTY_VISUAL, id });
    const stop = followRun(id, (event) => setState((s) => reduceVisual(s, event)));
    return stop;
  }, [id, error]);

  const back = (
    <a
      className="back-link"
      href="/?tab=history"
      onClick={(e) => {
        if (isModifiedClick(e)) return;
        e.preventDefault();
        onBack();
      }}
    >
      ← All runs
    </a>
  );
  if (error) {
    return (
      <section className="eui-panel history-card">
        <div className="eui-panel-head">
          <div className="eui-head-text">
            <span className="eui-overline">Run</span>
            <span className="eui-title">Not available</span>
          </div>
          {back}
        </div>
        <div className="eui-panel-body">
          <Notice tone="attention" role="alert">{error}</Notice>
        </div>
      </section>
    );
  }
  const owner = opened?.owner ?? row?.sentBy;
  const startedAt = row?.startedAt ?? 0;
  const live = isRunning(state.phase);
  return (
    <div className="run-detail">
      <section className="eui-panel history-card">
        <div className="eui-panel-head">
          <div className="eui-head-text">
            <span className="eui-overline">Run</span>
            <span className="eui-title">{opened?.name ?? row?.name ?? "Loading"}</span>
          </div>
          <div className="eui-head-actions">
            {state.zipUrl && <a className="eui-ds-btn ghost sm" href={state.zipUrl} download>Download zip</a>}
            {back}
          </div>
        </div>
        <div className="eui-panel-body run-meta">
          {owner && owner !== server.owner && <span>Sent by <b>{owner}</b></span>}
          {startedAt > 0 && (
            <span>
              <time dateTime={new Date(startedAt).toISOString()} title={new Date(startedAt).toLocaleString("en")}>{relativeTime(startedAt, server.now)}</time>
            </span>
          )}
          {row && <StatusChip status={row.chip.status} label={row.chip.label} busy={row.live} />}
        </div>
      </section>
      <RunView
        state={state}
        aiChecks={server.aiChecks}
        modelKnown={server.capabilities?.reviewer === "pi"}
        onCancel={
          live
            ? () => {
                // the server answers a cancel with a plain error event; only this flag tells it apart from a failure
                setState((s) => reduceVisual(s, { type: "cancel-requested" }));
                void cancelRun(id);
              }
            : undefined
        }
      />
    </div>
  );
}
