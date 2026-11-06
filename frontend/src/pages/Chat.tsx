/* /chat (spec §12): the playground. Logged in, a request spends credits (hold → stream →
   settle → split) and leaves a receipt on HCS. Logged out, it shows World login and
   how an agent pays per request with x402 instead. */
import { useEffect, useRef, useState } from "react";
import type { Me, ModelEntry, Receipt, RouteHop } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import RouteTrace from "../components/chat/RouteTrace";
import TokMeter from "../components/chat/TokMeter";
import ReceiptSheet from "../components/chat/ReceiptSheet";
import InferenceTile from "../components/chat/InferenceTile";
import SourceBadge from "../components/SourceBadge";
import { Icon } from "../components/Icon";
import { ErrorBox, Loading } from "../components/console/Status";
import { api, InsufficientCredits, PaymentRequired, SessionExpired } from "../data";
import type { ChatBody } from "../data";
import { useModels, useNetwork } from "../hooks/usePool";
import { useSession } from "../auth/context";
import { available, estimateTokens, holdFor, liveStarter } from "../lib/credits";
import { fmtLeft, fmtMc, fmtNum } from "../lib/format";
import { navigate } from "../lib/router";
import { hashscanMessage } from "../lib/links";
import { env } from "../config/env";

type Msg = { role: "user" | "assistant"; content: string };
const SUGGESTIONS = ["How does a pool split one model across laptops?", "What does this answer cost in credits?", "How do laptop owners earn credits?"];
const cr = (n: number) => fmtNum(n, 1);
const short = (id: string) => id.split("/")[1] ?? id;

function BalancePanel({ me }: { me: Me }) {
  const balance = me.balance;
  const starter = liveStarter(balance);
  return (
    <section className="panel" aria-labelledby="bal-h">
      <h2 id="bal-h" className="mono-label">
        Credits
      </h2>
      <p className="stat-value bal-avail">
        {cr(available(balance))} <small>available</small>
      </p>
      <dl className="kv">
        <dt>Starter</dt>
        <dd>
          {cr(starter)} <span className="faint">· {fmtLeft(balance.starter_expires_at)} left</span>
        </dd>
        <dt>Earned</dt>
        <dd>
          {cr(balance.earned)} {me.incentives.locked_mc > 0 && <span className="faint">· {fmtMc(me.incentives.locked_mc)} vesting</span>}
        </dd>
        <dt>Held</dt>
        <dd>{cr(balance.held)}</dd>
        <dt>Ratio</dt>
        <dd>{me.ratio.toFixed(2)}</dd>
      </dl>
      <p className="faint">Starter credits are spent first, then credits your laptops earned serving other pools. A higher ratio goes first when a pool is busy.</p>
    </section>
  );
}

function LoginCard({ onLogin }: { onLogin: () => void }) {
  return (
    <section className="panel tile" aria-labelledby="login-h">
      <span className="mono-label">
        <Icon name="user-check" size={12} /> Credits
      </span>
      <h2 id="login-h">Log in to talk to the pool.</h2>
      <p className="muted">World ID proves you are a real person. One human gets one account, with 10,000 starter credits for 14 days. Each request costs model_factor × (output tokens + 0.2 × input tokens).</p>
      <div className="tile-actions">
        <button className="button button-blue" onClick={onLogin}>
          Log in with World ID <Icon name="arrow" size={15} />
        </button>
      </div>
    </section>
  );
}

export default function Chat({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const models = useModels();
  const net = useNetwork();
  const [picked, setModel] = useState<string | null>(null);
  // A new ?model= (e.g. "Query this pool" from /network) wins until the user picks again.
  const [lastQuery, setLastQuery] = useState(query.get("model"));
  if (query.get("model") !== lastQuery) {
    setLastQuery(query.get("model"));
    setModel(null);
  }
  const model = picked ?? query.get("model") ?? "";
  const pin = query.get("pool") ?? undefined;
  const [maxTokens, setMaxTokens] = useState<512 | 2048>(512);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [route, setRoute] = useState<RouteHop[] | null>(null);
  const [active, setActive] = useState(-1);
  const [tokS, setTokS] = useState<number | null>(null);
  const [ttft, setTtft] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const offers = models.data ?? [];
  const served = offers.filter((o) => o.served).map((o) => o.model);
  const entry: ModelEntry | undefined = served.find((m) => m.model_id === model) ?? served.find((m) => m.params_b >= 14) ?? served[0];
  const chosen = entry?.model_id ?? "";
  const nodes = net?.nodes ?? [];
  const me = session.me;

  const draft: Msg[] = [...msgs, ...(input.trim() ? [{ role: "user" as const, content: input.trim() }] : [])];
  const hold = entry ? holdFor(entry.model_factor, maxTokens, estimateTokens(draft.length ? draft : [{ content: "" }])) : 0;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || !entry || !session.token || !me) return;
    const history: Msg[] = [...msgs, { role: "user", content }];
    const need = holdFor(entry.model_factor, maxTokens, estimateTokens(history));
    // §5.3 step 4: the hold must fit; check before sending so nothing is held or charged.
    if (need > available(me.balance)) {
      setError(new InsufficientCredits(need, available(me.balance)));
      return;
    }
    setMsgs([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setReceipt(null);
    setTokS(null);
    setTtft(null);
    setActive(-1);
    setStreaming(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const body: ChatBody = { model: chosen, messages: history, max_tokens: maxTokens, pool_id: pin };
    let hops = 0;
    let tokens = 0;
    try {
      for await (const c of api.chat(body, session.token, ctl.signal)) {
        if (c.route) {
          setRoute(c.route);
          hops = c.route.length;
          void session.reload(); // shows the hold
        }
        if (c.ttft_ms != null) setTtft(c.ttft_ms);
        if (c.tok_s != null) setTokS(c.tok_s);
        if (c.delta) {
          tokens++;
          // each token passes every hop in turn; show where the activations are
          setActive(hops ? tokens % hops : -1);
          setMsgs((m) => {
            const next = m.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + c.delta };
            return next;
          });
        }
        if (c.done) {
          setActive(-2);
          if (ctl.signal.aborted) markStopped();
          if (c.receipt_id) {
            const rc = await api.request(c.receipt_id);
            setReceipt(rc);
            if (rc?.route.length) setRoute(rc.route);
          }
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        markStopped();
      } else if (err instanceof SessionExpired || err instanceof PaymentRequired) {
        session.logout();
        setError(err);
      } else {
        // §5.3 step 11: a failed request costs nothing.
        setError(err instanceof InsufficientCredits || /paid nothing/i.test(err.message) ? err : new Error(`${err.message} You paid nothing.`));
        setMsgs((m) => (m.at(-1)?.content === "" ? m.slice(0, -1) : m));
      }
      setActive(-1);
    } finally {
      setStreaming(false);
      abort.current = null;
      void session.reload();
    }
  }

  function markStopped() {
    setMsgs((m) => {
      const next = m.slice();
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content ? `${last.content} …` : "(stopped)" };
      return next;
    });
  }

  const head = (
    <PageHead
      label="PLAYGROUND · GATEWAY"
      title="Spend your credits on a pool."
      sub="Each model runs split across the laptops of one pool. Every reply shows the route it took through them and leaves a receipt on Hedera HCS."
    />
  );

  if (!session.token && !session.loading) {
    return (
      <>
        {head}
        <div className="grid grid-2 chat-out">
          <LoginCard onLogin={() => session.openLogin("/chat")} />
          <InferenceTile />
        </div>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="chat-layout">
        <aside className="stack chat-side">
          {me ? <BalancePanel me={me} /> : <Loading h={150} />}

          <section className="panel" aria-labelledby="model-h">
            <div className="panel-head">
              <h2 id="model-h" className="mono-label">
                Model
              </h2>
              <SourceBadge kind="arkiv" />
            </div>
            {models.error && !models.data ? (
              <ErrorBox error={models.error} retry={models.reload} />
            ) : !models.data ? (
              <Loading h={120} />
            ) : offers.length === 0 ? (
              <p className="faint">No model has a ready pool right now. Requests would get HTTP 503 and cost nothing. Check the network for pools that are loading.</p>
            ) : (
              <div className="model-pick" role="radiogroup" aria-label="Model">
                {offers.map(({ model: m, served: ok }) => (
                  <label key={m.model_id} className={`model-opt${chosen === m.model_id ? " is-on" : ""}${ok ? "" : " is-off"}`}>
                    <input type="radio" name="model" value={m.model_id} checked={chosen === m.model_id} disabled={!ok || streaming} onChange={() => setModel(m.model_id)} />
                    <span className="mono">{short(m.model_id)}</span>
                    <span className="faint">{ok ? `×${m.model_factor} · ${m.total_layers} layers · ${offers.find((o) => o.model.model_id === m.model_id)?.pools ?? 0} pools` : "no live pool"}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="pool-pin">
              {pin ? (
                <>
                  <span className="faint">Pinned to pool</span> <span className="mono">{pin}</span>
                  <button className="text-link" onClick={() => navigate(`/chat${chosen ? `?model=${encodeURIComponent(chosen)}` : ""}`, { replace: true })} disabled={streaming}>
                    Let the router pick
                  </button>
                </>
              ) : (
                <>
                  <span className="faint">The router picks the best ready pool.</span>
                  <button className="text-link" onClick={() => navigate("/network")}>
                    Pick one
                  </button>
                </>
              )}
            </div>
            <div className="field max-tok">
              <span className="mono-label">Max tokens</span>
              <div className="tabs" role="radiogroup" aria-label="Max tokens">
                {([512, 2048] as const).map((n) => (
                  <button key={n} role="radio" aria-checked={maxTokens === n} className={maxTokens === n ? "is-active" : ""} onClick={() => setMaxTokens(n)} disabled={streaming}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="mono-label">Speed</h2>
            <TokMeter tokS={tokS} ttft={ttft} />
          </section>
        </aside>

        <div className="stack chat-main">
          <RouteTrace route={route} nodes={nodes} active={streaming ? active : active === -2 ? -2 : -1} streaming={streaming} />

          <section className="panel chat-pane" aria-label="Conversation">
            <div className="chat-log" ref={log} aria-live="polite">
              {msgs.length === 0 ? (
                <div className="chat-empty">
                  <p className="muted">Ask anything. Or try one of these:</p>
                  <div className="suggestions">
                    {SUGGESTIONS.map((q) => (
                      <button key={q} className="suggestion" onClick={() => send(q)} disabled={!chosen || !me}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                msgs.map((m, i) => (
                  <div key={i} className={`msg msg-${m.role}`}>
                    <span className="mono-label">{m.role === "user" ? "You" : short(chosen)}</span>
                    <p>
                      {m.content}
                      {streaming && i === msgs.length - 1 && <i className="caret" aria-hidden="true" />}
                    </p>
                  </div>
                ))
              )}
            </div>
            {error && <ErrorBox error={error} />}
            {receipt && !streaming && (
              <button className="receipt-badge" onClick={() => setSheet(true)} aria-label="Open receipt">
                <Icon name="file" size={13} />
                <span className="mono">{cr(receipt.cost)} cr</span>
                {me && <span>balance {cr(available(me.balance))}</span>}
                {receipt.hcs_seq != null && <SourceBadge kind="hcs" seq={receipt.hcs_seq} href={hashscanMessage(env.hcsTopic, receipt.hcs_seq)} />}
              </button>
            )}
            <form
              className="chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <label htmlFor="chat-q" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-q"
                className="input"
                rows={2}
                placeholder={chosen ? `Message ${short(chosen)}…` : "No pool is serving a model right now"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                disabled={!chosen}
              />
              {streaming ? (
                <button type="button" className="button button-ghost" onClick={() => abort.current?.abort()}>
                  <Icon name="pause" size={14} /> Stop
                </button>
              ) : (
                <button className="button button-blue" disabled={!input.trim() || !chosen || !me}>
                  Send <Icon name="arrow-up" size={14} />
                </button>
              )}
            </form>
            {entry && (
              <p className="faint hold-note">
                Holds ≈ {fmtNum(hold, 0)} credits ({entry.model_factor} × ({maxTokens} + 0.2 × input)). You pay only for the tokens served.
              </p>
            )}
          </section>
        </div>
      </div>
      {sheet && receipt && <ReceiptSheet receipt={receipt} nodes={nodes} onClose={() => setSheet(false)} />}
    </>
  );
}
