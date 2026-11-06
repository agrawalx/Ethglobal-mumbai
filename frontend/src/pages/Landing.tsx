import { Suspense, lazy, useState } from "react";
import { Brand } from "../components/Shared";
import { Icon } from "../components/Icon";
import CrewScene from "../components/CrewScene";
import FigureBoundary from "../components/anatomy/FigureBoundary";
import PoolStory from "../components/story/PoolStory";
import { BRAND } from "../config/brand";
import { navigate } from "../lib/router";
import { useSession } from "../auth/context";

const LiveLayerSim = lazy(() => import("../components/sim/LiveLayerSim"));
const GpuHero = lazy(() => import("../components/anatomy/GpuHero"));
const LayerLine = lazy(() => import("../components/anatomy/LayerLine"));

/* The earn → spend loop, in order (SPEC §8). */
const steps = [
  {
    number: "01",
    title: "Prove you are human.",
    description: "Log in with World ID. One account per person, with 10,000 starter credits for 14 days to try any pool.",
  },
  {
    number: "02",
    title: "Lend your laptop to a pool.",
    description: "Your laptop joins a pool and serves the layers that fit in its memory. No single laptop has to hold the whole model.",
  },
  {
    number: "03",
    title: "Earn by the layer.",
    description: "90% of every request goes to the laptops that served it, by layers served. Your own requests pay your laptop nothing. Earnings unlock after an hour.",
  },
  {
    number: "04",
    title: "Spend on another pool.",
    description: "Use what you earned to query a different pool and model. Earn more than you spend and your requests go first when pools are busy.",
  },
];

export default function Landing() {
  const [menu, setMenu] = useState(false);
  const session = useSession();
  const openChat = () => navigate("/chat");
  // Logged in already → straight to the playground; otherwise World ID first.
  const login = () => (session.me ? navigate("/chat") : session.openLogin("/chat"));
  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <nav
          className={`nav-pill${menu ? " mobile-nav-open" : ""}`}
          aria-label="Main navigation"
        >
          <a
            className="nav-current"
            href="#platform"
            onClick={() => setMenu(false)}
          >
            Platform
          </a>
          <a href="#how-it-works" onClick={() => setMenu(false)}>
            How it works
          </a>
          <a href="#the-pool" onClick={() => setMenu(false)}>
            Earn and spend
          </a>
          <a href="#simulator" onClick={() => setMenu(false)}>
            Simulator
          </a>
          <a href="/network" onClick={() => setMenu(false)}>
            Network
          </a>
          <a href="/getting-started" onClick={() => setMenu(false)}>
            Become a provider
          </a>
        </nav>
        <div className="header-actions">
          <button
            className="button button-blue header-cta"
            onClick={openChat}
          >
            Try it now <Icon name="arrow-up" size={15} />
          </button>
          <button
            className="icon-button mobile-menu-button"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? "close" : "menu"} />
          </button>
        </div>
      </header>
      <main>
        <section className="hero-section" id="platform">
          <div className="hero-atmosphere" aria-hidden="true" />
          <div className="hero-copy">
            <span className="eyebrow">
              <i className="status-dot" /> SPARE GPUS. ONE BIGGER MODEL.
            </span>
            <h1>
              Your laptop, idle tonight.
              <br />
              Part of something bigger.
            </h1>
          </div>
          <div className="hero-aside">
            <p>
              Your laptop serves a slice
              <br />
              of a model too big for it.
              <br />
              Each request earns credits.
              <br />
              Spend them on any pool.
            </p>
            <button className="text-link" onClick={login}>
              {session.me ? "Open the playground" : "Log in with World ID"}{" "}
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="hero-figure">
            <FigureBoundary ratio="640 / 520">
              <GpuHero caption={false} />
            </FigureBoundary>
          </div>
          <div className="scene-caption">
            <span className="tiny-cross">+</span>
            <span>MANY SMALL GPUS. ONE MODEL.</span>
          </div>
          <a
            className="hero-scroll"
            href="#the-pool"
            aria-label="Scroll to meet the pool"
          >
            <span>THERE’S A WHOLE POOL BEHIND THIS.</span>
            <Icon name="arrow" size={15} />
          </a>
          <div className="pointer-hint">
            <span /> HOVER THE CARD
          </div>
        </section>
        <section className="warm-section content-section" id="the-pool">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> SERVE, EARN, SPEND
            </span>
            <span className="section-index">01 / THE LOOP</span>
          </div>
          <div className="section-intro">
            <h2>
              Serve one pool.
              <br />
              Spend in another.
            </h2>
            <p>
              Like seeding a torrent: you give compute now and use it later.
              <br className="desktop-break" /> A pool can be two laptops or twenty.
              Each one serves its
              <br className="desktop-break" /> share of the layers, and the gateway pays it
              for exactly that share.
            </p>
          </div>
          <div id="the-crew" className="landing-crew"><p className="faint">An illustration of one pool. The Network page lists every live pool and node.</p>
            <CrewScene variant="landing" />
          </div>
          <div className="journey-steps">
            {steps.map((step) => (
              <div className="journey-step" key={step.number}>
                <span>{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="content-section sim-section" id="simulator">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> SPLIT A MODEL, FOLLOW A QUERY
            </span>
            <span className="section-index">02 / SIMULATOR</span>
          </div>
          <div className="section-intro">
            <h2>
              Add laptops.
              <br />
              Watch the layers move.
            </h2>
            <p>
              Change how many laptops are in the pool and how much memory each has.
              <br className="desktop-break" /> The layers split by memory, a query runs stage by stage, and the
              <br className="desktop-break" /> credits settle with the gateway's real formula. Switch to a live pool to use a real layer map.
            </p>
          </div>
          <Suspense fallback={<div className="sim sim-loading" aria-busy="true" />}>
            <LiveLayerSim />
          </Suspense>
        </section>
        <section className="story-section" id="how-it-works">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> FROM INSTALL TO PAYOUT
            </span>
            <span className="section-index">03 / HOW IT WORKS</span>
          </div>
          <div className="story-intro">
            <h2>
              Seven steps.
              <br />
              One shared model.
            </h2>
            <p>
              Scroll through what happens between installing the node agent
              and the first HBAR claim.
            </p>
          </div>
          <div className="story-figure">
            <FigureBoundary ratio="760 / 460">
              <LayerLine />
            </FigureBoundary>
          </div>
          <PoolStory />
        </section>
        <section className="conversation-section content-section">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> EVERY CREDIT ON THE RECORD
            </span>
            <span className="section-index">04 / THE LEDGER</span>
          </div>
          <div className="conversation-layout">
            <div>
              <h2>
                A request settles.
                <br />
                The record stays.
              </h2>
              <p>
                Each request writes a receipt: route, cost and split.
                <br />
                The gateway signs it and sends it to Hedera HCS,
                <br className="desktop-break" /> so anyone can check it on
                HashScan.
              </p>
              <button
                className="text-link"
                onClick={() => navigate("/ledger")}
              >
                See the ledger <Icon name="arrow" size={17} />
              </button>
            </div>
            <div className="landing-exchange">
              <div>
                <span className="exchange-name">
                  Stage 1 · RTX 4060 <i />
                </span>
                <p>
                  My layers are done.
                  <br />
                  Handing off to the next stage.
                </p>
              </div>
              <div>
                <span className="exchange-name iris-name">
                  Hedy · Gateway <i />
                </span>
                <p>
                  592.2 credits settled.
                  <br />
                  90% to the route by layers.
                </p>
              </div>
              <div>
                <span className="exchange-name quil-name">
                  Pod <i />
                </span>
                <p>Receipt on HCS #1877.</p>
              </div>
              <span className="exchange-caption">AN ILLUSTRATIVE RECEIPT</span>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer" id="footer">
        <div className="footer-top">
          <div>
            <span className="section-label">SOME BIG MODELS START SMALL.</span>
            <h2>
              Lend a laptop.
              <br />Use the whole network.
            </h2>
            <button className="button button-blue" onClick={login}>
              {session.me ? "Open the playground" : "Log in with World ID"}{" "}
              <Icon name="arrow-up" size={17} />
            </button>
          </div>
          <nav aria-label="Footer navigation">
            <span>TAKE A LOOK AROUND</span>
            <a href="#how-it-works">
              How it works <Icon name="arrow-up" size={14} />
            </a>
            <a href="/chat">
              Playground <Icon name="arrow-up" size={14} />
            </a>
            <a href="/network">
              Network <Icon name="arrow-up" size={14} />
            </a>
            <a href="/ledger">
              Ledger <Icon name="arrow-up" size={14} />
            </a>
            <a href="/payouts">
              Payouts <Icon name="arrow-up" size={14} />
            </a>
            <a href={BRAND.repo} target="_blank" rel="noreferrer">
              Source on GitHub <Icon name="arrow-up" size={14} />
            </a>
            <a href="/privacy.html">
              Privacy <Icon name="arrow-up" size={14} />
            </a>
          </nav>
        </div>
        <div className="footer-bottom">
          <Brand />
          <span>Built at ETHGlobal Mumbai.</span>
          <a href="#platform">
            Back to the stars <Icon name="arrow-up" size={13} />
          </a>
          <span className="footer-year">2026</span>
        </div>
      </footer>
    </div>
  );
}
