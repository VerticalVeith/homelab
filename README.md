# Homelab

Based on: https://github.com/argoproj/argoproj-deployments

## Onboarding

Some stuff is based on https://www.suse.com/c/rancher_blog/deploying_ha_k3s_external_database/

TODO: 
- local hostnames
- certificate renewal
- configuring the server node
- disabling swap

### Creating the lxc containers

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
    pct pull <postgres-vmid> /var/lib/pgsql/data/postgres.crt
    pct push <k3s-server-vmid> postgres.crt /root/.ssh/ --group root --user root
    rm postgres.crt
    ```

- To make sure incoming connections are trustworthy, postgres can ensure the caller has a certificate from a trusted party. We let the k3s Server sign the certificates, so we need the `.crt`. First, to create the certificates, run the following in the k3s server node:

    ```bash
    openssl req -new -x509 -days 365 -nodes -text -out /root/.ssh/k3s.crt -keyout /root/.ssh/k3s.key -subj "/CN=k3s" -addext "subjectAltName=DNS:k3s"
    chmod 0600 /root/.ssh/k3s.key
    ```

- And again we need to make the `.crt` file available to postgres:

    ```bash
    pct pull <k3s-server-vmid> /root/.ssh/k3s.crt
    pct push <k3s-server-vmid> k3s.crt /var/lib/pgsql/data/ --group postgres --user postgres
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

- To finish up, we update the `/var/lib/pgsql/data/pg_hba.conf` to allow all clients using ssl:

    ```
    hostssl all             all             0.0.0.0/0               md5 clientcert=verify-full
    ```
 
We can `sudo -u postgres psql` to access the postgres server.

### Setup k3s

- Since we use postgres as the datastore for k3s, we need to create the user and table:

    ```sql
    sudo -u postgres psql

    CREATE DATABASE k3s;
    CREATE USER k3s WITH ENCRYPTED PASSWORD '<somepassword>';
    GRANT ALL PRIVILEGES ON DATABASE k3s TO k3s;
    \c k3s
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO k3s;
    EXIT;
    ```

- We are now ready to install the k3s server:

    ```bash
    curl -sfL https://get.k3s.io | sh -s - server --disable=servicelb --datastore-endpoint='postgres://k3s:<thepassword>@postgres.buergerhoff.local:5432/k3s' --datastore-cafile="/root/.ssh/postgres.crt" --datastore-certfile="/root/.ssh/k3s.crt" --token=k3s --datastore-keyfile="/root/.ssh/k3s.key" --node-name control.k8s --node-label topology.kubernetes.io/region=Home --node-label topology.kubernetes.io/zone=buergerhoff
    ```

- And now we can join the k3s cluster on our workload container:

    ```bash
    curl -sfL https://get.k3s.io | sh -s - agent --token=k3s --server https://k3s-crtl.buergerhoff.com:6443 --node-label topology.kubernetes.io/region=Home --node-label topology.kubernetes.io/zone=buergerhoff
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
    kubectl apply -k https://github.com/VerticalVeith/homelab/argocd
    kubectl apply -k https://github.com/VerticalVeith/homelab/argoproj
    ```
