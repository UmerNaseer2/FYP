import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`,
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (session.user?.email) {
        try {
          const result = await pool.query(
            'SELECT role FROM profiles WHERE email = $1',
            [session.user.email]
          );
          session.user.role = result.rows[0]?.role || 'viewer';
        } catch (error) {
          session.user.role = 'viewer';
        }
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
});

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      name?: string;
      email?: string;
      role?: string;
    };
  }
}