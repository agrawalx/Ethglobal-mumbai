import { useEffect } from "react";
import { PageHead } from "../components/ConsoleShell";
import { Icon } from "../components/Icon";
import { ErrorBox, Loading } from "../components/console/Status";
import ProviderForm from "../components/provider/ProviderForm";
import PoolSetup from "../components/provider/PoolSetup";
import { useSession } from "../auth/context";
import { useAsync } from "../hooks/useAsync";
import { navigate } from "../lib/router";
import { providerApi } from "../data/provider";
import { SessionExpired } from "../data/api";

export default function GettingStarted({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const { token, logout, openLogin } = session;
  const rawMode = query.get("mode"), mode = rawMode === "create" || rawMode === "join" ? rawMode : null;
  const data = useAsync(() => session.token ? providerApi.overview(session.token) : Promise.resolve(null), [session.token], { refreshMs: session.token ? 3000 : undefined });
  useEffect(() => {
    if (token && data.error instanceof SessionExpired) { logout(); openLogin(`/getting-started${mode ? `?mode=${mode}` : ""}`); }
  }, [data.error, token, mode, logout, openLogin]);
  function choose(choice: "create" | "join") {
    const path = `/getting-started?mode=${choice}`;
    navigate(path);
    if (!session.token) session.openLogin(path);
  }
  return <div className="provider-page">
    <PageHead label="PROVIDERS / GETTING STARTED" title={<>Your laptop.<br />A bigger possibility.</>} sub="Bring your compute to the network. Start a pool with your crew, or add your laptop to one that already exists." aside={<span className="provider-hero-mark" aria-hidden="true"><Icon name="pod" size={64} /><span>+ + +</span></span>} />
    <div className="provider-choices" aria-label="Choose how to contribute">
      <button className={`provider-choice ${mode === "create" ? "is-selected" : ""}`} onClick={() => choose("create")} aria-pressed={mode === "create"}>
        <span className="mono-label">01 / START SOMETHING</span><span className="provider-choice-title"><Icon name="pod" size={27} />Create a pool<Icon name="arrow-up" size={22} /></span><span className="muted">Choose a model, invite your members and coordinate the pipeline.</span><span className="provider-choice-note">You become the coordinator</span>
      </button>
      <button className={`provider-choice ${mode === "join" ? "is-selected" : ""}`} onClick={() => choose("join")} aria-pressed={mode === "join"}>
        <span className="mono-label">02 / BRING YOUR COMPUTE</span><span className="provider-choice-title"><Icon name="laptop" size={27} />Join a pool<Icon name="arrow-up" size={22} /></span><span className="muted">Have a Pool ID? Request a place and let your laptop do its part.</span><span className="provider-choice-note">Your own account. Your own earnings.</span>
      </button>
    </div>
    <div className="provider-flow" aria-label="Setup steps"><span><Icon name="user-check" size={16} />Verify with World</span><i aria-hidden="true">→</i><span><Icon name="file" size={16} />Run one command</span><i aria-hidden="true">→</i><span><Icon name="chip" size={16} />Prepare your model</span><i aria-hidden="true">→</i><span><Icon name="bolt" size={16} />Serve together</span></div>
    {session.loading ? <Loading /> : mode && !session.token ? <section className="panel provider-login"><Icon name="user-check" size={26} /><div><h2>One human. Your own contribution.</h2><p className="muted">Log in with World ID to {mode === "create" ? "create your pool" : "request membership"}. Your choice stays here after verification.</p></div><button className="button button-blue" onClick={() => session.openLogin(`/getting-started?mode=${mode}`)}>Continue with World ID<Icon name="arrow" size={14} /></button></section> : null}
    {data.error && <ErrorBox error={data.error} retry={data.reload} />}
    {session.token && data.loading && !data.data && <Loading />}
    {session.token && mode && data.data && <ProviderForm key={mode} mode={mode} models={data.data.models} done={() => { data.reload(); navigate("/getting-started"); }} />}
    {session.token && data.data?.pools.map(pool => <PoolSetup key={pool.pool_id} pool={pool} refresh={data.reload} />)}
    <section className="provider-ground-rules"><div><span className="mono-label">LOCAL COMPUTE</span><p>Connect your crew over Ethernet. The coordinator prepares the model cache; the helpers handle the setup and report progress here.</p></div><div><span className="mono-label">CENTRAL ACCOUNTING</span><p>World identity, credit accounting and payments stay with the marketplace. Your helper receives permission for your node only.</p></div><div><span className="mono-label">OWNER CONTROL</span><p>You approve machine access. Keep Terminal open while serving, and stop your helper whenever you need your laptop back.</p></div></section>
  </div>;
}
