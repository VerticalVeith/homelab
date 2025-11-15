# Homelab

Based on: https://github.com/argoproj/argoproj-deployments

## Onboarding

Some stuff is based on https://www.suse.com/c/rancher_blog/deploying_ha_k3s_external_database/ and https://gist.github.com/triangletodd/02f595cd4c0dc9aac5f7763ca2264185 https://kevingoos.medium.com/kubernetes-inside-proxmox-lxc-cce5c9927942

TODO: 
- local hostnames
- certificate renewal


### Adding ssh key to node

    ```bash
    scp .ssh/id_rsa.pub root@pve.buergerhoff.local:/root/.ssh/authorized_keys
    ```

### Creating the containers

- List available container templates

    ```bash
    pveam update
    pveam available --section system
    ```

- Download the alpine and debian templates

    ```bash
    pveam download local alpine-3.22-default_20250617_amd64.tar.xz
    pveam download local debian-13-standard_13.1-2_amd64.tar.zst
    ```

- Create Containers

    > [!WARNING]
    > Proxmox appears to be bugged and does not recognice debian 13 as a valid template.
    > You can fix this by modifying the check:
    >
    > <!-- language: lang-bash -->
    > 
    >     sed -i '39s/\($version <= \)13/\114/' /usr/share/perl5/PVE/LXC/Setup/Debian.pm

    ```bash
    mkdir -p /var/lib/vz/snippets
    bang='!'
    echo "#${bang}/bin/bash
    
    # This script load the required kernel modules and sets required sysctl values for k3s
    modprobe overlay br_netfilter iptable_nat nft-chain-2-nat nft-expr-counter nfnetlink-subsys-11
    sysctl -w net/netfilter/nf_conntrack_max=131072
    " > /var/lib/vz/snippets/200.sh
    chmod +x /var/lib/vz/snippets/200.sh

    alpineTemplate="alpine-3.22-default_20250617_amd64.tar.xz"
    debianTemplate="debian-13-standard_13.1-2_amd64.tar.zst"
    password="<password"

    adressPrefix="192.168.12"
    # because the contents is our public key
    publicKeyPath="/root/.ssh/authorized_keys"
    baseConfig="--onboot true --start true --ssh-public-keys $publicKeyPath --password $password --storage local-lvm"

    pct create 100 local:vztmpl/$alpineTemplate --cores 2 --memory 2048 --description "The postgres host" --hostname "postgres" --ostype alpine --net0 name=eth0,bridge=vmbr0,gw=$adressPrefix.1,ip=$adressPrefix.212/24 $baseConfig

    pct create 200 local:vztmpl/$debianTemplate --cores 2 --memory 2048 --swap 0 --hostname "k3s-server1" --description "The k3s server node" --ostype debian --unprivileged 0 --net0 name=eth0,bridge=vmbr0,gw=$adressPrefix.1,ip=$adressPrefix.215/24 --features nesting=1 --hookscript local:snippets/200.sh $baseConfig
    pct create 210 local:vztmpl/$debianTemplate --cores 2 --memory 2048 -swap 0 --hostname "k3s-agent1" --description "The k3s agent node" --ostype debian --unprivileged 0 --net0 name=eth0,bridge=vmbr0,gw=$adressPrefix.1,ip=$adressPrefix.217/24 --features nesting=1 $baseConfig

- Setup advanced k3s container config
    ```bash
    echo "lxc.apparmor.profile: unconfined
    lxc.cgroup2.devices.allow: a
    lxc.cap.drop:
    lxc.mount.auto: \"proc:rw sys:rw\"" >> /etc/pve/lxc/200.conf
    ```

- Setting up ssh and required dependencies for the alpine container

    ```bash
    apk add openssh openssl
    rc-update add sshd
    rc-service sshd start
    ```

- Setting up the required dependencies for the k3s server

    ```bash
    apt install curl iptables git -y
    ```

- Setting up the required dependencies for the k3s agent

    ```bash
    apt install curl -y
    ```

### Creating the Postgres Server

- Installing postgres and creating the data directory for later:

    ```bash
    apk add postgresql16 postgresql16-contrib postgresql16-openrc
    rc-update add postgresql
    rc-service postgresql start
    mkdir -p -- /var/lib/pgsql/data
    ```

- This setup uses certificates. Create a keypair to prove the postgres authenticity to consumers:

    ```bash
    postgresHost="postgres.buergerhoff.local"
    openssl req -new -x509 -days 365 -nodes -text -out /var/lib/pgsql/data/postgres.crt -keyout /var/lib/pgsql/data/postgres.key -subj "/CN=$postgresHost" -addext "subjectAltName=DNS:$postgresHost"
    chown postgres:postgres /var/lib/pgsql/data/postgres.key /var/lib/pgsql/data/postgres.crt
    chmod 0600 /var/lib/pgsql/data/postgres.key
    ```

- Our k3s Server Nodes need the crt file to be able to know it's the real one. Copy it to `/root/.ssh/` in the k3s server container. You can do this from the proxmox node, but make sure the file permissions are correct:

    ```bash
    pct pull 100 /var/lib/pgsql/data/postgres.crt postgres.crt 
    pct push 200 postgres.crt /root/.ssh/postgres.crt --group root --user root
    rm postgres.crt
    ```

- To make sure incoming connections are trustworthy, postgres can ensure the caller has a certificate from a trusted party. We let the k3s Server sign the certificates, so we need the `.crt`. First, to create the certificates, run the following in the k3s server node:

    ```bash
    openssl req -new -x509 -days 365 -nodes -text -out /root/.ssh/k3s.crt -keyout /root/.ssh/k3s.key -subj "/CN=k3s" -addext "subjectAltName=DNS:k3s"
    chmod 0600 /root/.ssh/k3s.key
    ```

- And again we need to make the `.crt` file available to postgres and the agent:

    ```bash
    pct pull 200 /root/.ssh/k3s.crt k3s.crt
    pct push 100 k3s.crt /var/lib/pgsql/data/k3s.crt --group postgres --user postgres
    rm k3s.crt
    ```

- Now we can configure postgres to not just listen to localhost and adding the created certificates:

    ```bash
    vi /etc/postgresql16/postgresql.conf
    ```

    and set the following config keys: 

    ```conf
    listen_addresses = '*'
    ssl = on
    ssl_cert_file = '/var/lib/pgsql/data/postgres.crt'
    ssl_key_file = '/var/lib/pgsql/data/postgres.key'
    ssl_ca_file = '/var/lib/pgsql/data/k3s.crt'
    ```

- To finish up, we update the `/var/lib/postgresql/16/data/pg_hba.conf` to allow all clients using ssl:

    ```
    hostssl all             all             0.0.0.0/0               md5 clientcert=verify-full
    ```
- Restart postgres

  ```bash
  rc-service postgresql restart
  ```

We can `su postgres` and to run `psql` access the postgres server.

### Setup k3s

- Since we use postgres as the datastore for k3s, we need to create the user and table:

    ```sql
    su postgres
    psql

    CREATE DATABASE k3s;
    CREATE USER k3s WITH ENCRYPTED PASSWORD 'Daca123!';
    GRANT ALL PRIVILEGES ON DATABASE k3s TO k3s;
    \c k3s
    GRANT ALL ON SCHEMA public TO k3s;
    \q
    ```

- k3s needs kmsg, but we can just forward `/dev/console`

    for the server node:

    ```bash
    cat << EOF > /etc/rc.local
    #/bin/sh -e

    # Kubeadm 1.15 needs /dev/kmsg to be there, but it's not in lxc, but we can just use /dev/console instead
    # see: https://github.com/kubernetes-sigs/kind/issues/662
    if [ ! -e /dev/kmsg ]; then
        ln -s /dev/console /dev/kmsg
    fi

    # https://medium.com/@kvaps/run-kubernetes-in-lxc-container-f04aa94b6c9c
    mount --make-rshared /
    EOF

    chmod +x /etc/rc.local
    reboot
    ```

    for the client node:
    ```bash
    cat << EOF > /etc/rc.local
    #/bin/sh -e

    # Kubeadm 1.15 needs /dev/kmsg to be there, but it's not in lxc, but we can just use /dev/console instead
    # see: https://github.com/kubernetes-sigs/kind/issues/662
    if [ ! -e /dev/kmsg ]; then
        ln -s /dev/console /dev/kmsg
    fi

    # https://medium.com/@kvaps/run-kubernetes-in-lxc-container-f04aa94b6c9c
    mount --make-rshared /
    EOF

    chmod +x /etc/rc.local
    reboot
    ```

- The last thing we need to do is prepare sysctl

    And add/update the following keys `nano /etc/sysctl.conf`:

    ```conf
    vm.swapiness=0
    net.ipv4.ip_forward=1
    ```

- We are now ready to install the k3s server:

    ```bash
    password="<postgres password>"
    curl -sfL https://get.k3s.io | sh -s - server --disable servicelb --disable traefik --disable-network-policy --datastore-endpoint="postgres://k3s:$password@postgres.buergerhoff.local:5432/k3s" --datastore-cafile="/root/.ssh/postgres.crt" --datastore-certfile="/root/.ssh/k3s.crt" --datastore-keyfile="/root/.ssh/k3s.key" --node-label topology.kubernetes.io/region=home --node-label topology.kubernetes.io/zone=buergerhoff
    cat /var/lib/rancher/k3s/server/agent-token
    ```

- And now we can join the k3s cluster on our workload container:

    ```bash
    token="<node token>"
    curl -sfL https://get.k3s.io | sh -s - agent --server https://k3s-server1.buergerhoff.local:6443 --node-label topology.kubernetes.io/region=home --node-label topology.kubernetes.io/zone=buergerhoff --token $token
    ```

We should now see our nodes:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes -A
```

### Setting up the Proxmox CSI Plugin

This allows kubernetes to use storage from the Proxmox host. Installation based on the [installation docs](https://github.com/sergelogvinov/proxmox-csi-plugin/blob/main/docs/install.md).

- Be sure proxmox is clustered by visiting Datacenter->Cluster. It is fine to cluster a proxmox instance with itself.

- We are currently not using zfs replication, so we do not need as many permissions for our user. In Proxmox, run this to create a new user and role with the required permissions (be sure to save the value of the user token):

    ```bash
    pveum role add CSI -privs "VM.Audit VM.Config.Disk Datastore.Allocate Datastore.AllocateSpace Datastore.Audit"
    pveum user add kubernetes-csi@pve
    pveum aclmod / -user kubernetes-csi@pve -role CSI
    pveum user token add kubernetes-csi@pve csi -privsep 0
    ```

- ! This is currently broken. We set the secret in the proxmoxcsi until I figure out how the hell the config secret files work:

    ```bash
    mkdir /etc/proxmox && echo "<the token value>" > /etc/proxmox/token_secret && echo 'kubernetes-csi@pve!csi' > /etc/proxmox/token_id
    ```

### Bootstraping GitOps

This repo contains all the GitOps manifest files. ArgoCD can manage itself, but we need to get it going first:

    ```bash
    kubectl apply -k https://github.com/VerticalVeith/homelab/manifests/base/argocd/install
    kubectl apply -f https://raw.githubusercontent.com/VerticalVeith/homelab/refs/heads/main/manifests/argocd.yaml
    ```

## Issues

rrdcache broken: `mv /var/lib/rrdcached/db/pve-node-9.0/pve3 /var/lib/rrdcached/db/pve-node-9.0/pve3.bak`
when the initial setup fails: delete the database and retry
