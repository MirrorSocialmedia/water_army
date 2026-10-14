import { FutureApiPage } from '../components/FutureApiPage';

export function Tasks() {
  return (
    <FutureApiPage
      endpoint="/api/tasks/runs"
      phase="P3"
      title="AI task runs"
      description="Submit and track AI work via configured providers (queue → run → result, with events and audit)."
    />
  );
}

export default Tasks;
