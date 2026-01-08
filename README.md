# Homelab

Based on: https://github.com/argoproj/argoproj-deployments

## Onboarding

Some stuff is based on https://www.suse.com/c/rancher_blog/deploying_ha_k3s_external_database/ and https://gist.github.com/triangletodd/02f595cd4c0dc9aac5f7763ca2264185 https://kevingoos.medium.com/kubernetes-inside-proxmox-lxc-cce5c9927942


### Adding ssh key to node

    ```bash
    scp .ssh/id_rsa.pub root@pve.buergerhoff.lan:/root/.ssh/authorized_keys
    ```

### Creating the containers

- List available container templates

    ```bash
    pveam update
    pveam available --section system
    ```

- Download the alpine and debian templates

    ```bash
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

    debianTemplate="debian-13-standard_13.1-2_amd64.tar.zst"
    password="<password"

    adressPrefix="192.168.12"
    adressPrefixV6="2a04:4540:6513:1a00:be24:11ff:fe6b:4f1f/64"
    gatewayV6="2a04:4540:6513:1a00:6b4:feff:fe1f:f4c5"
    # because the contents is our public key
    publicKeyPath="/root/.ssh/authorized_keys"
    baseConfig="--onboot true --features nesting=1 --start true --ssh-public-keys $publicKeyPath --password $password --storage local-lvm"

    pct create 200 local:vztmpl/$debianTemplate --rootfs volume=local-lvm:25 --cores 2 --memory 2048 --swap 0 --hostname "k3s-server1" --description "The k3s server node" --ostype debian --unprivileged 0 --net0 name=eth0,bridge=vmbr0,gw=$adressPrefix.1,ip=$adressPrefix.215/24,gw6=$gatewayV6,ip6=$adressPrefixV6 --hookscript local:snippets/200.sh $baseConfig 
    pct create 210 local:vztmpl/$debianTemplate --rootfs volume=local-lvm:50 --cores 6 --memory 10240 -swap 0 --hostname "k3s-agent1" --description "The k3s agent node" --ostype debian --unprivileged 0 --net0 name=eth0,bridge=vmbr0,gw=$adressPrefix.1,ip=$adressPrefix.217/24,gw6=$gatewayV6,ip6=$adressPrefixV6 --mp0 volume=local-lvm,mp=/mnt/data,backup=1,ro=0,size=500G $baseConfig 

- Setup advanced k3s container config
    ```bash
    echo "lxc.apparmor.profile: unconfined
    lxc.cgroup2.devices.allow: a
    lxc.cap.drop:
    lxc.mount.auto: \"proc:rw sys:rw\"" >> /etc/pve/lxc/200.conf
    ```

- Setting up the required dependencies for the k3s server

    ```bash
    apt update && apt install curl iptables git -y
    ```

- Setting up the required dependencies for the k3s agent

    ```bash
    apt update && apt install curl -y
    ```

### Setup k3s

- k3s needs kmsg, but we can just forward `/dev/console`

    for the server and client node:

    ```bash
    cat << EOF > /etc/rc.local
    #!/bin/sh -e

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
    curl -sfL https://get.k3s.io | sh -s - server --disable servicelb --disable traefik --disable-network-policy --node-label topology.kubernetes.io/region=home --node-label topology.kubernetes.io/zone=buergerhoff --cluster-cidr=10.42.0.0/16,fd42::/48 --service-cidr=10.43.0.0/16,fd43::/112 --node-ip=192.168.12.215,2a04:4540:6513:1a00:be24:11ff:fe6b:4f1f --default-local-storage-path /mnt/data
    cat /var/lib/rancher/k3s/server/agent-token
    ```

- And now we can join the k3s cluster on our workload container:

    ```bash
    token=""
    curl -sfL https://get.k3s.io | sh -s - agent --server https://k3s-server1.buergerhoff.lan:6443 --node-label topology.kubernetes.io/region=home --node-label topology.kubernetes.io/zone=buergerhoff --token $token
    ```

We should now see our nodes:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes -A
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
