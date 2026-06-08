import AuthGuard from "@/components/AuthGuard";

export default function CompareLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}