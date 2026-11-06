/* The simulator with live pools from /network (Arkiv). Lazy-loaded by the landing so the data layer stays out of its first bundle. */
import LayerSim from "./LayerSim";
import { useNetwork } from "../../hooks/usePool";

export default function LiveLayerSim() {
  const net = useNetwork();
  return <LayerSim pools={net?.pools ?? []} nodes={net?.nodes ?? []} />;
}
