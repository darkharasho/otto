import { UpdaterSection } from '../UpdaterSection';

export function UpdatesSection({ version }: { version: string }) {
  return <UpdaterSection appVersion={version} />;
}
