kill 29727 2>/dev/null
sed -i "s#await new Promise(r => setTimeout(r, 1500));#await new Promise(r => setTimeout(r, 1500)); writeFileSync(`${D1}/probe-${DEV}.stage`, \"env+gl ok \" + Date.now());#" cdp-probe.mjs
