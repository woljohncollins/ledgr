import { SignIn } from "@clerk/nextjs";

// In-app sign-in page (vs Clerk's hosted account portal) so sign-in works
// the same on a dev instance today and a production instance once a real
// domain exists. Which connections show is per-instance Clerk dashboard
// config: Microsoft on Brandon's instance, Google on Tyler's.
export default function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <p className="text-sm text-neutral-500">
          Auth is not configured (no Clerk publishable key). See runbook.md §1.
        </p>
      </main>
    );
  }
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <SignIn />
    </main>
  );
}
