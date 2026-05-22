import AuthGuard from "@/components/AuthGuard";

export default function ConnectionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}