import AuthGuard from "@/components/AuthGuard";

export default function VersionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}