/* Everything behind "Try it now". Lazy-loaded so the landing never ships wagmi / IDKit. */
import Chat from "./pages/Chat";
import Network from "./pages/Network";
import Account from "./pages/Account";
import Ledger from "./pages/Ledger";
import Payouts from "./pages/Payouts";
import NotFound from "./pages/NotFound";
import GettingStarted from "./pages/GettingStarted";
import ConsoleShell from "./components/ConsoleShell";
import Providers from "./wallet/Providers";
import WalletButton from "./wallet/WalletButton";
import type { Route } from "./lib/router";

function page(route: Route) {
  switch (route.name) {
    case "provider":
      return <GettingStarted query={route.query} />;
    case "chat":
      return <Chat query={route.query} />;
    case "account":
      return <Account query={route.query} />;
    case "network":
      return <Network />;
    case "ledger":
      return <Ledger query={route.query} />;
    case "payouts":
      return <Payouts />;
    default:
      return <NotFound />;
  }
}

export default function ConsoleRoot({ route }: { route: Route }) {
  // The wallet is only needed where HBAR moves: payout address (/account) and claims (/payouts).
  const wallet = route.name === "payouts" || route.name === "account" || route.name === "provider" ? <WalletButton /> : null;
  return (
    <Providers>
      <ConsoleShell current={route.name} wallet={wallet}>
        {page(route)}
      </ConsoleShell>
    </Providers>
  );
}
