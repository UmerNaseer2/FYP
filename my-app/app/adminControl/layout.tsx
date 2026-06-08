import AuthGuard from "@/components/AuthGuard";

export default function adminControlLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}