import { FutureApiPage } from '../components/FutureApiPage';

export function Schedules() {
  return (
    <FutureApiPage
      endpoint="/api/schedules"
      phase="P4"
      title="Schedules"
      description="Cron / interval schedules persisted in PostgreSQL, synced idempotently to BullMQ job schedulers."
    />
  );
}

export default Schedules;
