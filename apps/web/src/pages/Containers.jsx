import { FutureApiPage } from '../components/FutureApiPage';

export function Containers() {
  return (
    <FutureApiPage
      endpoint="/api/containers"
      phase="P2"
      title="Docker containers"
      description="List, inspect, log and control containers (managed-label gating + audit)."
    />
  );
}

export default Containers;
