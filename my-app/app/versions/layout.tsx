import AuthGuard from "@/components/AuthGuard";

export default function versionlayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}