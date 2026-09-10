import { useCallback, useEffect, useState } from "react";
import { normaliseCode } from "./api";
import { usePinnedConfiguration } from "./hooks/usePinnedConfiguration";
import { EntryPage } from "./pages/EntryPage";
import { PreflightPage } from "./pages/PreflightPage";
import { RoomPage } from "./pages/RoomPage";

export function App() {
  const configuration = usePinnedConfiguration();
  const [locationKey, setLocationKey] = useState(() => `${location.pathname}${location.search}`);
  useEffect(() => {
    const onPopState = () => setLocationKey(`${location.pathname}${location.search}`);
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((path: string) => {
    history.pushState(null, "", path);
    setLocationKey(path);
    scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const path = locationKey.split("?")[0] ?? "/";
  const roomMatch = path.match(/^\/room\/([A-Z0-9]{20})$/i);
  if (roomMatch?.[1]) {
    return (
      <RoomPage
        code={normaliseCode(roomMatch[1])}
        configuration={configuration}
        navigate={navigate}
      />
    );
  }
  if (path === "/preflight") {
    return <PreflightPage configuration={configuration} navigate={navigate} />;
  }
  const initialCode = new URLSearchParams(location.search).get("room") ?? "";
  return <EntryPage configuration={configuration} navigate={navigate} initialCode={initialCode} />;
}
