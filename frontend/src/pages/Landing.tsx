import { useCallback, useState } from "react";
import { Brand } from "../components/Shared";
import { Icon } from "../components/Icon";
import CrewScene from "../components/CrewScene";
import ParticleStage from "../components/ParticleStage";
import PoolStory from "../components/story/PoolStory";
import { BRAND } from "../config/brand";
import { navigate } from "../lib/router";
import { useSession } from "../auth/context";

const steps = [
  {
    number: "01",
    title: "Log in with World ID.",
    description: "One human, one account. You start with 10,000 credits.",
  },
  {
    number: "02",
    title: "Ask the pool.",
    description: "One model, split across three laptops, answers you.",
  },
  {
    number: "03",
    title: "Pay your way.",
    description:
      "Spend credits, or let an AI agent pay per request with x402.",
  },
  {
    number: "04",
    title: "Share your laptop.",
    description:
      "Add your GPU to the pool. Earn credits, and HBAR every epoch.",
  },
];

export default function Landing() {
  const [phase, setPhase] = useState<"cube" | "tree">("cube"),
    [menu, setMenu] = useState(false);
  const phaseChange = useCallback(
    (next: "cube" | "tree") => setPhase(next),
    [],
  );
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
            The pool
          </a>
          <a href="/network" onClick={() => setMenu(false)}>
            Network
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
          <ParticleStage onPhase={phaseChange} />
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
              A spare GPU goes a long way.
              <br />
              Pool a gaming laptop and two 16 GB Macs.
              <br className="desktop-break" /> Together they run Qwen3-14B,
              <br className="desktop-break" /> a model none of them can hold
              alone.
            </p>
            <button className="text-link" onClick={login}>
              {session.me ? "Open the playground" : "Log in with World ID"}{" "}
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="scene-caption">
            <span className="tiny-cross">+</span>
            <span>
              {phase === "cube"
                ? "MANY SMALL GPUS. ONE MODEL."
                : "ONE HUMAN. ONE ACCOUNT."}
            </span>
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
            <span /> MOVE TO EXPLORE
          </div>
        </section>
        <section className="warm-section content-section" id="the-pool">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> FROM IDLE TO EARNING
            </span>
            <span className="section-index">01 / A LITTLE POOLING</span>
          </div>
          <div className="section-intro">
            <h2>
              A pool is just a few laptops
              <br />
              agreeing to share.
            </h2>
            <p>
              You bring the spare GPU. The pool brings the rest.
              <br />
              One model is split across three laptops, and the gateway
              <br className="desktop-break" /> pays each one for the layers it
              serves.
            </p>
          </div>
          <div id="the-crew" className="landing-crew">
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
        <section className="story-section" id="how-it-works">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> FROM INSTALL TO PAYOUT
            </span>
            <span className="section-index">02 / HOW IT WORKS</span>
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
          <PoolStory />
        </section>
        <section className="conversation-section content-section">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> EVERY CREDIT ON THE RECORD
            </span>
            <span className="section-index">03 / THE LEDGER</span>
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
                  Rex · RTX 4060 <i />
                </span>
                <p>
                  Layers 0–11 done.
                  <br />
                  Handing off to Mika.
                </p>
              </div>
              <div>
                <span className="exchange-name iris-name">
                  Hedy · Gateway <i />
                </span>
                <p>
                  592 credits settled.
                  <br />
                  Split by layers.
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
              One laptop.
              <br />A whole pool.
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
