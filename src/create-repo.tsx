import { LaunchProps, popToRoot } from "@raycast/api";
import { useMemo, useRef } from "react";
import { CreateRepoForm } from "./components/CreateRepoForm";
import { readCachedIndex, reconcilePath } from "./lib/cache";
import { getConfig } from "./lib/config";

export default function Command(props: LaunchProps<{ arguments: { name?: string } }>) {
  const config = getConfig();
  const index = useRef(readCachedIndex(config.root)).current;
  const entries = useMemo(() => index?.entries ?? [], [index]);

  return (
    <CreateRepoForm
      entries={entries}
      initialName={props.arguments?.name || props.fallbackText}
      onCreated={async (fullPath) => {
        if (index) await reconcilePath(index, fullPath, config.defaultProtocol);
        await popToRoot();
      }}
    />
  );
}
