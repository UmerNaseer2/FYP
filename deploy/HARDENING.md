# Locking down the server

[README.md](README.md) gets Schema Studio running and updating itself. This
guide secures the computer it runs on, for a server where that is already
done. It takes about half an hour in the server's terminal, through Splashtop.

| | Before | After |
| --- | --- | --- |
| Security updates | Not checked | Checked to be installing every day |
| Who runs the app | The everyday login, which can also control Docker | An account of its own that nobody can log in as |
| What goes live | Any commit on `main` that passes CI | Only commits signed with your key that pass CI |
| Network | No firewall, Portainer open to every network | Firewall on, Portainer only from private networks |
| Deploy log | A file that grows forever | The system journal, which trims itself |

Do the steps in order, and read each command's output before the next one.
This guide was written without access to the server, so if a command prints
something the guide does not expect, stop there and find out why. Step 5 could
cut off remote access if it went wrong, so it comes with a switch that undoes
it by itself after ten minutes.

Every command runs on the server unless it says "on your own computer".

Before a disk image of the server is taken, see [DISK-IMAGE.md](DISK-IMAGE.md)
for what it holds and what to clean up first.

## 0. Before you start

The server must already run the updater that checks signatures. It arrives
by itself within ten minutes of reaching `main`. Check:

```text
grep -c verify-commit ~/FYP/deploy/auto-update.sh
```

Any number above 0 means it is there.

## 1. Look first

```text
lsb_release -ds
hostname -I
getent group sudo docker
sudo ss -tlnp
sudo ufw status
sudo iptables -S DOCKER-USER
cat /etc/apt/apt.conf.d/20auto-upgrades
dpkg -l docker-ce docker.io 2>/dev/null | grep '^ii'
```

Note down:

- **`hostname -I`**, the server's addresses. Step 5 assumes the first one
  starts with `10.`, `172.16.` to `172.31.`, or `192.168.`: the private
  ranges most campus networks use inside. If it starts with anything else,
  ask IT which address ranges the campus uses, and use those in step 5.
- **`getent group`**, the logins allowed to use `sudo` and the ones allowed to
  use Docker. Being in either group is as good as being the server's
  administrator.
- **`ss`**, the programs waiting for connections. Ones on `127.0.0.1` or
  `[::1]` can only be reached from the server itself, so the firewall does not
  matter to them. Expect `docker-proxy` on ports 8000 and 9443 (Portainer).
  Note whether `sshd` (port 22) or Splashtop (port 6783) is there. Ask IT
  about any other program before step 5, because the firewall will close its
  port.
- **`ufw status`**, most likely `inactive`.
- **`iptables -S DOCKER-USER`**, which should print only `-N DOCKER-USER`,
  maybe followed by `-A DOCKER-USER -j RETURN`. If it prints more, IT has
  rules of their own there, and step 5.2 would replace them: ask IT first.

## 2. Security updates

Ubuntu installs security updates every day by itself, unless someone turned
that off. The `cat` in step 1 should have printed:

```text
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

If the file is missing or a line says `"0"`, turn it on, and answer Yes:

```text
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

The next day, check it ran:

```text
sudo tail -n 5 /var/log/unattended-upgrades/unattended-upgrades.log
```

Two things the automatic updates do not cover:

- **Restarts.** A new kernel takes effect only after a restart, and the
  server does not restart by itself. Keep it that way until IT confirms
  Splashtop comes back after a restart with nobody at the keyboard. Until
  then, once a month, run `ls /var/run/reboot-required`. If the file exists,
  arrange a restart with IT.
- **Docker, if it came from Docker's own package source.** If the `dpkg` line
  in step 1 says `docker-ce`, the automatic updates skip it (`docker.io` is
  Ubuntu's own package and is covered). Ask IT whether they update it.
  Updating Docker restarts it, which takes the app and Portainer offline for
  a moment.

The app's containers are the updater's job instead: it fetches the newest
`node` and `postgres` images whenever it deploys, and once a week at night
even when nobody pushes (README.md, How it works).

## 3. Deploy only commits signed with your key

The updater now deploys a commit only if it is signed with a key listed in
`/etc/schema-studio/allowed_signers`. That file sits outside the code folder
and belongs to root, so nothing pushed to GitHub can change it. Someone who
gets push access to GitHub, with a stolen password or token, can push code but
cannot sign it, and the server skips it.

Until the file exists, the server deploys nothing new and logs `Not deploying
...: there is no list of trusted signing keys`.

### On your own computer

Make a signing key, and tell git to sign every commit in your clone with it.
Skip what is already done:

```text
ssh-keygen -t ed25519 -N "" -C "schema-studio deploy signing" -f ~/.ssh/fyp_signing
cd <your clone of the repository>
git config gpg.format ssh
git config user.signingkey ~/.ssh/fyp_signing
git config commit.gpgsign true
```

Print the line for the server, and the key's fingerprint:

```text
awk '{print "deploy namespaces=\"git\"", $1, $2}' ~/.ssh/fyp_signing.pub
ssh-keygen -lf ~/.ssh/fyp_signing.pub
```

The private key, `~/.ssh/fyp_signing`, never leaves your computer. Only the
public half, in the line above, goes on the server.

### On the server

```text
sudo mkdir -p /etc/schema-studio
sudo nano /etc/schema-studio/allowed_signers
```

Paste the line (Splashtop passes the clipboard across; if it does not, type
it with care), save with Ctrl+O and Enter, and quit with Ctrl+X. Then:

```text
sudo chmod 644 /etc/schema-studio/allowed_signers
awk '{print $3, $4}' /etc/schema-studio/allowed_signers | ssh-keygen -lf -
git -C ~/FYP -c gpg.ssh.allowedSignersFile=/etc/schema-studio/allowed_signers verify-commit HEAD
```

The fingerprint (`SHA256:...`) must match the one your computer printed, and
the last command should say `Good "git" signature for deploy`. It checks the
commit the server runs now, which was signed.

Good to know:

- Signing a commit approves it and everything before it. If `git pull` brings
  commits you did not write, read them before you commit on top.
- Commits made on GitHub's website are signed by GitHub, not by you, so the
  server skips them. To approve one, push a signed commit after it. An empty
  one is enough.
- To let someone else deploy, add their line under yours. If you lose your
  key, make a new one and replace your line.

## 4. Give the app an account of its own

So far the updater has run as the everyday login, and that login can use
Docker. This step moves Schema Studio to `/srv/schema-studio`, owned by a new
account, `schemastudio`, that nobody can log in as. A systemd timer then runs
the updater as that account, instead of cron. The app may go offline for
about a minute, in step 4.4.

### 4.1 Stop the old cron lines

```text
crontab -l | grep -v -e auto-update.sh -e backup.sh | crontab -
crontab -l
ls ~/FYP/.deploy.lock
```

The second command should no longer list `auto-update.sh` or `backup.sh`,
and the third should say `No such file or directory`. If the lock is there, a
deploy or a backup is running: wait five minutes and check again.

### 4.2 Make the account

```text
sudo adduser --system --group --home /var/lib/schema-studio schemastudio
sudo usermod -aG docker schemastudio
```

A system account has no password and no login shell, so nobody can log in
as it.

### 4.3 Move the folder

```text
sudo mv ~/FYP /srv/schema-studio
sudo chown -R schemastudio:schemastudio /srv/schema-studio
ls -l /srv/schema-studio/.env
```

The last line should start with `-rw-------` and name `schemastudio`: only
that account, and root, can read the secrets.

### 4.4 Start it from the new place

```text
cd /srv/schema-studio
sudo -u schemastudio docker compose up -d
sudo -u schemastudio docker compose ps
```

Compose finds the same containers and database volume, because `.env` keeps
the project name `schema-studio`. It may recreate the containers, since the
folder moved. The data stays in the volume either way. Both should say
`healthy` within two minutes.

Then run the updater once by hand, as the new account:

```text
sudo -u schemastudio ./deploy/auto-update.sh
```

It should print `Up to date at` and a commit id.

### 4.5 Turn on the timers

```text
sudo cp deploy/systemd/schema-studio-*.service deploy/systemd/schema-studio-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now schema-studio-update.timer schema-studio-backup.timer
systemctl list-timers 'schema-studio-*'
```

The last command shows when each runs next: the updater within five minutes,
the backup at 02:30. The files are copied, not linked, so a commit cannot
change how they run. If a later commit changes them, copy them again.

Save a copy of the database now, to see the backup works as the new account:

```text
sudo systemctl start schema-studio-backup.service
sudo journalctl -t schema-studio-backup -n 3
```

The last line should say `Saved backups/schema-studio-` and the date.

### 4.6 Take Docker away from the everyday login

```text
sudo gpasswd -d "$USER" docker
```

From the next login on, Docker commands need `sudo`. This counts for most
once the everyday login also loses `sudo` (step 6). If IT's own scripts use
Docker as this login, ask them before you run it.

### What changes in README.md

| README.md says | From now on |
| --- | --- |
| `~/FYP` | `/srv/schema-studio` |
| `tail -f ~/schema-studio-deploy.log` | `sudo journalctl -t schema-studio-update -f` |
| `docker compose ...` | `sudo -u schemastudio docker compose ...`, in `/srv/schema-studio` |
| `git ...` | `sudo -u schemastudio git ...`, in `/srv/schema-studio` |
| `./deploy/auto-update.sh` | `sudo -u schemastudio ./deploy/auto-update.sh` |
| Turning it off with `crontab -e` | `sudo systemctl disable --now schema-studio-update.timer` |
| `~/schema-studio-backup.log` | `sudo journalctl -t schema-studio-backup` |
| `./deploy/backup.sh` | `sudo systemctl start schema-studio-backup.service` |

The old logs, `~/schema-studio-deploy.log` and `~/schema-studio-backup.log`,
are no longer written to.

## 5. Firewall

Two parts. `ufw`, Ubuntu's firewall, guards the server's own programs. Docker
goes around `ufw` for container ports, so Portainer's ports get a rule of
their own, in the chain Docker keeps for this, `DOCKER-USER`. Both parts let
in the private ranges `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`. If
IT gave you other ranges in step 1, use those instead.

The app and its database are not affected: they listen on `127.0.0.1` only
(README.md, step 4).

### 5.1 The server's own ports

```text
sudo ufw default deny incoming
sudo ufw default allow outgoing
```

These change nothing until `ufw` is turned on in 5.3. If step 1 showed `sshd`
on port 22, let the private ranges in:

```text
sudo ufw allow from 10.0.0.0/8 to any port 22 proto tcp
sudo ufw allow from 172.16.0.0/12 to any port 22 proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
```

Do the same with `6783` in place of `22` if step 1 showed Splashtop on 6783.
That port is only for direct Splashtop connections inside the network.
Connections through Splashtop's cloud start from the server, and the firewall
lets those through.

### 5.2 Portainer's ports

This part is for Portainer in a container with published ports: `ss` in step
1 showed `docker-proxy` on 9443 and 8000, or did not list them at all. If it
showed `portainer` itself on them, Portainer uses the server's own network,
Docker does not go around `ufw` for it, and the `ufw allow` lines of 5.1 with
`9443` and `8000` in place of `22` do the job instead of this part.

Open the file `ufw` loads last:

```text
sudo nano /etc/ufw/after.rules
```

Add this at the very end, after the last `COMMIT`, and save:

```text
# Schema Studio, deploy/HARDENING.md: Portainer only from private networks
*filter
:DOCKER-USER - [0:0]
:portainer-guard - [0:0]
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 9443 --ctdir ORIGINAL -j portainer-guard
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 8000 --ctdir ORIGINAL -j portainer-guard
-A portainer-guard -s 10.0.0.0/8 -j RETURN
-A portainer-guard -s 172.16.0.0/12 -j RETURN
-A portainer-guard -s 192.168.0.0/16 -j RETURN
-A portainer-guard -j DROP
COMMIT
```

Connections to ports 9443 and 8000 from a private address carry on to
Portainer as before, and all others are dropped. Docker's own networks use
private addresses too, so the containers' own traffic is not affected.

### 5.3 Turn it on, with a safety switch

The first command sets a switch that turns the firewall off again in ten
minutes. If the firewall cuts off Splashtop, wait ten minutes and reconnect.
`ufw enable` warns that it may disrupt ssh connections: answer `y`.

```text
sudo systemd-run --unit=ufw-undo --on-active=10min /usr/sbin/ufw disable
sudo ufw enable
sudo ufw status verbose
sudo iptables -S portainer-guard
```

The last command should list the four `portainer-guard` lines. Then, within
the ten minutes, check:

1. Splashtop still works: this terminal still answers.
2. The app still answers. This should print `200`:

   ```text
   curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/login
   ```

3. If you can, from a laptop on the campus network, `https://<the server's
   address>:9443` still shows Portainer's login page.

If all is well, cancel the switch:

```text
sudo systemctl stop ufw-undo.timer
```

If the ten minutes run out first, the switch turns the firewall off. Run
`sudo ufw enable` again, without the switch if Splashtop was fine.

To undo step 5 later, `sudo ufw disable` turns off the rules for the server's
own ports. To remove the Portainer rule too, delete the block from
`/etc/ufw/after.rules`, then run `sudo iptables -F DOCKER-USER`.

## 6. Ask IT

The steps above are what the shared login can do. These need IT:

- **Personal logins.** Give each person who uses the server a login of their
  own with a strong password, keep `sudo` for IT's admins, and retire the
  shared login. As long as a shared login has `sudo`, anyone who knows its
  password controls the server and can undo every step in this guide.
- **Screen lock.** Lock the screen after a few idle minutes, so nobody can
  walk up to the PC and use the logged-in session.
- **Portainer.** Who uses it, and from which addresses? With that, step 5.2
  can let in just those instead of every private address. Also a strong
  password, and keeping Portainer itself updated.
- **Restarts.** Does Splashtop come back after a restart with nobody at the
  keyboard? If it does, turn on automatic restarts for kernel updates, at
  night, in `/etc/apt/apt.conf.d/50unattended-upgrades`:

  ```text
  Unattended-Upgrade::Automatic-Reboot "true";
  Unattended-Upgrade::Automatic-Reboot-Time "03:00";
  ```

- **A public link.** See
  [Before the link is made public](README.md#before-the-link-is-made-public).
  IT's proxy must reach the app, so `APP_PORT` changes, and the app's port
  then needs a rule like the one in 5.2, so that only the proxy reaches it.

## On GitHub

- Check who can push to the repository (its Settings, Collaborators), and
  delete the personal access tokens you no longer use (your Settings,
  Developer settings). After step 3, a stolen token can no longer put code on
  the server, but it can still change the code on GitHub.
- Optional: add `~/.ssh/fyp_signing.pub` to your GitHub account as a
  **signing key** (Settings, SSH and GPG keys, New SSH key, key type Signing
  Key). GitHub then marks your commits Verified, and you can turn on the
  branch rule "Require signed commits" for `main`.

## Not covered

- The signature check was tested against a copy of the repository with
  signed, unsigned and wrongly signed commits. The firewall rules and the
  systemd files were not run on Ubuntu before this guide was written. Every
  step says what it should print, so a difference shows up right away.
- The containers have caps on memory and on the number of processes, cannot
  gain new rights, and keep at most 30 MB of their own logs, and the app's
  container drops all of Docker's extra rights. Their file systems are still
  writable. CI starts the whole stack in Docker on every push, with these
  settings, so one that Docker refuses fails CI before it reaches the server.
