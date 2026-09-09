import { useEffect, useState } from "react";
import { getProfileDiagSnapshot, onProfileDiagChange, type ProfileDiagSnapshot } from "./profileDiag";

/** Reactive access to the last captured raw users/{uid} read — see
 * profileDiag.ts. Null until the first read completes (or forever, in
 * demo mode, where no Firestore read ever happens). */
export function useProfileDiag(): ProfileDiagSnapshot | null {
  const [snapshot, setSnapshot] = useState(() => getProfileDiagSnapshot());

  useEffect(() => {
    setSnapshot(getProfileDiagSnapshot());
    return onProfileDiagChange(() => setSnapshot(getProfileDiagSnapshot()));
  }, []);

  return snapshot;
}
