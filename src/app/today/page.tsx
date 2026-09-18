// The Today surface. If the owner has assigned a dashboard as Today, render it;
// otherwise the fixed Today layout (shared with the Work home /). Lets a user
// point a nav slot at /today and optionally drive it with a custom dashboard.
import { redirect } from "next/navigation";
import DashboardView from "@/components/dashboards/DashboardView";
import TodayHome from "@/app/_today-home";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function Today() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const settings = await getSettings(owner.id);
  if (settings.todayDashboardId) {
    return (
      <DashboardView
        ownerId={owner.id}
        dashboardId={settings.todayDashboardId}
        fallback={<TodayHome />}
      />
    );
  }
  return <TodayHome />;
}
