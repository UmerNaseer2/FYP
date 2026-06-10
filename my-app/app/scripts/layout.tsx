import AuthGuard from "@/components/AuthGuard";

export default function ScriptsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}