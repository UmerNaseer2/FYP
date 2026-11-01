import AuthGuard from "@/components/AuthGuard";

// No feature: asking for something is open to every member, whatever their role.
export default function RequestsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}
