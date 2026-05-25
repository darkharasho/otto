import { useRemoteStore } from './store';
import { Pair } from './pair';
import { Chat } from './chat';

export function App(): JSX.Element {
  const token = useRemoteStore((s) => s.token);
  return token ? <Chat /> : <Pair />;
}
