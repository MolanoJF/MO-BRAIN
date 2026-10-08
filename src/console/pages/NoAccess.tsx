import { sessionApi } from '../api.ts';
import { Button, Notice, PageTitle } from '../ui/index.tsx';

/** D5: reachable only once Google is configured — a Google account with no
 *  invitation can still complete sign-in, and this is the honest landing
 *  spot for that session instead of a silently broken app shell. */
export function NoAccess({ email }: { email: string }) {
  const signOut = async () => {
    await sessionApi.signOut();
    window.location.reload();
  };

  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 p-6">
      <PageTitle>No access yet</PageTitle>
      <Notice tone="warning">
        <span>
          Signed in as <strong>{email}</strong>, but this account isn&apos;t a member of this
          brain. Ask an admin to invite this address, or sign in with a different account.
        </span>
      </Notice>
      <Button variant="primary" onClick={() => void signOut()}>Sign out</Button>
    </div>
  );
}
