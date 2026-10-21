import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { GoalsScreen } from "@/screens/goals-screen";

export default function GoalsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <GoalsScreen />
    </HostRouteBootstrapBoundary>
  );
}
