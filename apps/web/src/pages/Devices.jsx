import { FutureApiPage } from '../components/FutureApiPage';

export function Devices() {
  return (
    <FutureApiPage
      endpoint="/api/devices/redroid"
      phase="P5"
      title="Redroid devices"
      description="Create and manage Redroid Android test devices (template allowlist, localhost-only ADB, GPU status states)."
    />
  );
}

export default Devices;
