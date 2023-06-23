import getProvider from '@snapshot-labs/snapshot.js/src/utils/provider';
import { sendTransaction } from '@snapshot-labs/snapshot.js/src/utils';
import { getInstance } from '@snapshot-labs/lock/plugins/vue3';
import { sleep } from '@snapshot-labs/snapshot.js/src/utils';
import { Contract } from '@ethersproject/contracts';
import { BigNumber } from '@ethersproject/bignumber';
import { formatUnits, parseUnits } from '@ethersproject/units';
import { useStorage } from '@vueuse/core';
import {
  generateSalt,
  getCollection,
  getSpaceCollection
} from '@/helpers/nftClaimer';

import { ExtendedSpace, Proposal } from '@/helpers/interfaces';

const spaceCollectionsInfo = useStorage(
  'snapshot.proposals.nftCollections',
  {}
);

export function useNFTClaimer(space: ExtendedSpace, proposal?: Proposal) {
  const NETWORK_KEY = '5';
  const WETH_CONTRACT_ADDRESS = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6';
  const WETH_CONTRACT_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address guy, uint256 wad) external returns (bool)'
  ];
  const DEPLOY_CONTRACT_ADDRESS = '0x054a600d8B766c786270E25872236507D8459D8F';
  const DEPLOY_IMPLEMENTATION_ADDRESS =
    '0x33505720a7921d23E6b02EB69623Ed6A008Ca511';
  const DEPLOY_ABI = [
    'function deployProxy(address implementation, bytes initializer, uint256 salt, uint8 v, bytes32 r, bytes32 s)'
  ];
  const MINT_CONTRACT_ABI = [
    'function balanceOf(address, uint256 id) view returns (uint256)',
    'function mint(address proposer, uint256 proposalId, uint256 salt, uint8 v, bytes32 r, bytes32 s)',
    'function mintPrice() view returns (uint256)',
    'function mintPrices(uint256 proposalId) view returns (uint256)',
    'function maxSupply() view returns (uint128)',
    'function supplies(uint256 proposalId) view returns (uint256)'
  ];

  const mintNetwork = ref(NETWORK_KEY);
  const mintCurrency = ref('WETH');
  const mintPrice = ref('0.1');

  const inited = ref(false);
  const loading = ref(false);

  const auth = getInstance();
  const { web3, web3Account } = useWeb3();
  const { modalAccountOpen } = useModal();

  const networkKey = computed(() => web3.value.network.key);
  const provider = getProvider(NETWORK_KEY);

  const { t } = useI18n();
  const { notify } = useFlashNotification();
  const {
    createPendingTransaction,
    updatePendingTransaction,
    removePendingTransaction
  } = useTxStatus();

  const { profiles, loadProfiles } = useProfiles();

  async function _switchNetwork() {
    // check current network
    if (networkKey.value === NETWORK_KEY) return;

    // switch network
    await window.ethereum?.request({
      method: 'wallet_switchEthereumChain',
      params: [
        {
          chainId: `0x${NETWORK_KEY}`
        }
      ]
    });
    await sleep(1000);
  }

  const contractWETH = new Contract(
    WETH_CONTRACT_ADDRESS,
    WETH_CONTRACT_ABI,
    provider
  );

  async function _checkWETHBalance() {
    const balanceRaw = web3Account.value
      ? await contractWETH.balanceOf(web3Account.value)
      : 0;
    const balance = formatUnits(balanceRaw, 18);
    console.log(':_checkWETHBalance balance', balance);

    const mintPriceWei = parseUnits(mintPrice.value, 18);
    if (BigNumber.from(balanceRaw).lt(mintPriceWei))
      throw new Error('Not enough WETH balance');
  }

  async function _checkWETHApproval(address: string) {
    const allowanceRaw = web3Account.value
      ? await contractWETH.allowance(web3Account.value, address)
      : 0;
    const allowance = formatUnits(allowanceRaw, 18);
    console.log(':_checkWETHApproval allowance', allowance);

    const mintPriceWei = parseUnits(mintPrice.value, 18);
    if (BigNumber.from(allowanceRaw).lt(mintPriceWei)) {
      // TODO check id for next? to throttle?
      const txPendingId = createPendingTransaction();
      try {
        const tx = await sendTransaction(
          auth.web3,
          WETH_CONTRACT_ADDRESS,
          WETH_CONTRACT_ABI,
          'approve',
          [address, mintPriceWei]
        );
        console.log(':_checkWETHApproval tx', tx);
        updatePendingTransaction(txPendingId, { hash: tx.hash });
        await tx.wait();
      } catch (e) {
        notify(['red', t('notify.somethingWentWrong')]);
        console.log(e);
      } finally {
        removePendingTransaction(txPendingId);
      }
    }
  }

  async function _getBackendPayload(type: string, payload: any) {
    const res = await fetch(
      `${import.meta.env.VITE_SIDEKICK_URL}/api/nft-claimer/${type}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    return res.json();
  }

  function getSpaceCollectionInfo() {
    return getSpaceCollection(space.id);
  }

  function getCollectionInfo() {
    return getCollection(BigInt(proposal?.id as string));
  }

  async function init() {
    if (!space) return;

    let spaceCollectionInfo = spaceCollectionsInfo.value[space.id];

    if (
      !spaceCollectionInfo ||
      spaceCollectionInfo.createdAt < Date.now() - 1000 * 60
    ) {
      console.log('_init FRESH', space.id);
      const info = await getSpaceCollectionInfo();

      if (info) {
        spaceCollectionInfo = {
          address: info.id,
          maxSupply: parseInt(info.maxSupply),
          mintPrice: parseInt(info.mintPrice),
          formattedMintPrice: formatUnits(info.mintPrice, 18),
          proposerFee: parseInt(info.proposerFee),
          treasuryAddress: info.spaceTreasury,
          enabled: info.enabled,
          createdAt: Date.now()
        };

        spaceCollectionsInfo.value[space.id] = spaceCollectionInfo;
      }
    }

    if (proposal && spaceCollectionInfo) {
      const info = await getCollectionInfo();

      spaceCollectionsInfo.value[space.id].proposals ||= {};
      const defaultInfo = {
        id: null,
        mintCount: 0,
        mints: []
      };

      spaceCollectionsInfo.value[space.id].proposals[proposal.id] =
        info ?? defaultInfo;
      loadProfiles(
        spaceCollectionsInfo.value[space.id].proposals[proposal.id].mints.map(
          p => p.minterAddress
        )
      );

      if (
        spaceCollectionsInfo.value[space.id].proposals[proposal.id].mintCount >=
        spaceCollectionsInfo.value[space.id].maxSupply
      ) {
        spaceCollectionsInfo.value[space.id].enabled = false;
      }
    }

    inited.value = true;
  }

  // async function enableNFTClaimer() {
  //   if (!web3Account.value) {
  //     modalAccountOpen.value = true;
  //     return;
  //   }
  //   const txPendingId = createPendingTransaction();
  //   try {
  //     console.log(':enableNFTClaimer start');
  //     await _switchNetwork();

  //     const salt = BigNumber.from(randomBytes(32)).toString();
  //     const signature = await _getPayload('proposal', salt);
  //     console.log(':enableNFTClaimer signature', signature);
  //     return;
  //   } catch (e) {
  //     notify(['red', t('notify.somethingWentWrong')]);
  //     console.log(e);
  //   } finally {
  //     removePendingTransaction(txPendingId);
  //   }
  // }

  // async function disableNFTClaimer() {
  //   const txPendingId = createPendingTransaction();
  //   try {
  //     console.log(':disableNFTClaimer start');
  //   } catch (e) {
  //     notify(['red', t('notify.somethingWentWrong')]);
  //     console.log(e);
  //   } finally {
  //     removePendingTransaction(txPendingId);
  //   }
  // }

  async function sendTx(address: string, callback: () => Promise<any>) {
    const txPendingId = createPendingTransaction();

    try {
      await _switchNetwork();
      await _checkWETHBalance();
      await _checkWETHApproval(address);

      const tx: any = await callback();

      console.log(':mint tx', tx);

      notify(t('notify.transactionSent'));
      updatePendingTransaction(txPendingId, { hash: tx.hash });
      const receipt = await tx.wait();
      console.log('Receipt', receipt);
      notify(t('notify.youDidIt'));
    } catch (e) {
      notify(['red', t('notify.somethingWentWrong')]);
      console.log(e);
    } finally {
      removePendingTransaction(txPendingId);
    }
  }

  async function mint() {
    if (!web3Account.value) {
      modalAccountOpen.value = true;
      return;
    }

    loading.value = true;

    try {
      const { signature, salt, proposer, proposalId } =
        await _getBackendPayload('mint', {
          proposalAuthor: proposal?.author,
          id: proposal?.id,
          address: web3Account.value,
          salt: generateSalt()
        });

      await sendTx(spaceCollectionsInfo.value[space.id].address, () => {
        return sendTransaction(
          auth.web3,
          spaceCollectionsInfo.value[space.id].address,
          MINT_CONTRACT_ABI,
          'mint',
          [proposer, proposalId, salt, signature.v, signature.r, signature.s]
        );
      });
    } finally {
      loading.value = false;
    }
  }

  async function deploy(params: Record<string, string | number>) {
    if (!web3Account.value) {
      modalAccountOpen.value = true;
      return;
    }

    loading.value = true;

    try {
      const { signature, initializer, salt } = await _getBackendPayload(
        'deploy',
        {
          id: space.id,
          address: web3Account.value,
          salt: generateSalt(),
          maxSupply: params.maxSupply,
          mintPrice: parseUnits(
            params.formattedMintPrice.toString(),
            18
          ).toString(),
          proposerFee: params.proposerFee,
          spaceTreasury: params.treasuryAddress
        }
      );

      await sendTx(DEPLOY_IMPLEMENTATION_ADDRESS, () => {
        return sendTransaction(
          auth.web3,
          DEPLOY_CONTRACT_ADDRESS,
          DEPLOY_ABI,
          'deployProxy',
          [
            DEPLOY_IMPLEMENTATION_ADDRESS,
            initializer,
            salt,
            signature.v,
            signature.r,
            signature.s
          ]
        );
      });
    } finally {
      loading.value = false;
    }
  }

  return {
    spaceCollectionsInfo,
    loading,
    mintNetwork,
    mintCurrency,
    inited,
    profiles,
    // enableNFTClaimer,
    // disableNFTClaimer,
    mint,
    deploy,
    init
  };
}