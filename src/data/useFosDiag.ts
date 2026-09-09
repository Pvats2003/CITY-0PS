import { useEffect, useState } from "react";
import { getFosDiagSnapshot, onFosDiagChange, type FosDiagSnapshot } from "./fosDiag";

export function useFosDiag(): FosDiagSnapshot | null {
  const [snapshot, setSnapshot] = useState(() => getFosDiagSnapshot());
  useEffect(() => {
    setSnapshot(getFosDiagSnapshot());
    return onFosDiagChange(() => setSnapshot(getFosDiagSnapshot()));
  }, []);
  return snapshot;
}
