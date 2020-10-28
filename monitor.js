const Web3 = require("web3");
const BN = require('bignumber.js');
const TelegramBot = require('node-telegram-bot-api');

// Replace the value below with the Telegram token you receive from @BotFather
const token = "YOUR_TELEGRAM_BOT_TOKEN";

// You can get it using this steps: https://stackoverflow.com/a/32572159
const chatId = 1;

// Replace it with you staker accoount
const account = "YOUT_STAKER_ACCOUNT";

// Replace the URL with your infura endpoint
const web3 = new Web3(new Web3.providers.HttpProvider("https://mainnet.infura.io/v3/INFURA_TOKEN"));

const { StakingEscrow } = require('./contract-registry');

const contracts = {
  "stakingEscrowAddress": "0xbbD3C0C794F40c4f993B03F65343aCC6fcfCb2e2",
  "tokenAddress": "0x4fe83213d56308330ec302a8bd641f1d0113a4cc",
  "policyManagerAddress": "0x67E4A942c067Ff25cE7705B69C318cA2Dfa54D64",
  "workLockAddress": "0xe9778E69a961e64d3cdBB34CF6778281d34667c2"
}

const contract = new web3.eth.Contract(StakingEscrow, contracts.stakingEscrowAddress);

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, {polling: false});

function telegrambot (message, json) {
  try {
    bot.sendMessage(chatId, message + '\n\n<pre>' + JSON.stringify(json, null, 2) + '</pre>', {
      parse_mode: 'html'
    });
  } catch (err) {
    console.log('Something went wrong when trying to send a Telegram notification', err);
  }
}

class Node {
  constructor(obj) {
    this.lockReStakeUntilPeriod = obj.lockReStakeUntilPeriod;
    this.workerAddress = obj.worker;
    this.workerBalance = null;
    this.workerStartPeriod = obj.workerStartPeriod;
    this.lastActivePeriod = obj.lastActivePeriod;
    this.completedWork = obj.completedWork;
    this.pastDowntime = obj.pastDowntime;
    this.totalStake = obj.value;
    this.substakes = [];
    this.stakerAddress = null;
    this.stakerBalance = null;
    this.lockedTokens = null;
    this.availableForWithdraw = null;
    this.currentPeriod = null;
    this.flags = obj.flags;
    this.workerState = null;
    this.lastConfirmationCost = null;
  }
}

class SubStake {
  constructor(obj) {
    this.index = obj.index;
    this.firstPeriod = obj.firstPeriod;
    this.lastPeriod = obj.lastPeriod;
    this.value = obj.value;
    this.remainingDuration = obj.remainingDuration;
  }
}

function getWorkerState( currentPeriod, lastActivePeriod){
  let workerActivityState = null;
  if ( lastActivePeriod === '0') {
    workerActivityState = 'Never confirmed activity';
  } else if (currentPeriod < lastActivePeriod) {
    workerActivityState =  'Next period confirmed';
  } else if (currentPeriod === lastActivePeriod) {
    workerActivityState =  'Current period confirmed. Next period confirmation pending';
  } else if (currentPeriod > lastActivePeriod) {
    workerActivityState = 'Current period is not confirmed';
  }

  return workerActivityState
}

function isHexNil(hex) {
  return hex === '0x0000000000000000000000000000000000000000';
}

function toNumberOfTokens(amount) {
  return BN(Web3.utils.fromWei(amount.toString())).toNumber();
}

async function getNodeInfo() {
  const node = new Node(await contract.methods.stakerInfo(account).call());
  node.lockedTokens = await contract.methods.getLockedTokens(account, 1).call();
  node.availableForWithdraw = toNumberOfTokens((new web3.utils.BN(node.totalStake)).sub(new web3.utils.BN(node.lockedTokens)).toString());
  if (!isHexNil(node.worker)) {
    node.lastActivePeriod = await contract.methods.getLastCommittedPeriod(account).call();
  }
  node.stakerAddress = account;
  node.substakes = await getSubStakes();
  node.flags =  await getFlagsForStaker();
  node.currentPeriod = await getCurrentPeriod();
  node.stakerBalance = await getBalance(node.stakerAddress);
  node.workerBalance = await getBalance(node.workerAddress);
  node.workerState = getWorkerState(node.currentPeriod,node.lastActivePeriod)
  node.lastConfirmationCost = await getLastGasCost();
  return node;
}

async function getSubStakes() {
  const substakesCount = await contract.methods.getSubStakesLength(account).call();
  const substakes = [];
  for (let currentSubStakeIndex = 0; currentSubStakeIndex < substakesCount; currentSubStakeIndex++) {
    const subStake = await contract.methods.getSubStakeInfo(account, currentSubStakeIndex).call();
    const firstPeriod = new Date(1000 * 60 * 60 * 24 * subStake.firstPeriod);
    let lastPeriod;
    if (subStake.lastPeriod === '0') {
      lastPeriod = new Date();
      lastPeriod.setTime(lastPeriod.getTime() + ((+subStake.periods + 1) * 24 * 60 * 60 * 1000));
      lastPeriod.setHours(0, 0, 0, 0);
    } else {
      lastPeriod = new Date(1000 * 60 * 60 * 24 * (+subStake.lastPeriod + 1));
      lastPeriod.setHours(0, 0, 0, 0);
    }
    substakes.push(new SubStake({
      index: currentSubStakeIndex,
      firstPeriod,
      lastPeriod,
      value: subStake.lockedValue,
      remainingDuration: (+subStake.periods) + 1
    }));
  }
  return substakes;
}

async function getCurrentPeriod() {
  return await contract.methods.getCurrentPeriod().call();
}

async function getFlagsForStaker() {
  const flags = await contract.methods.getFlags(account).call();
  return flags;
}

async function getBalance(address) {
  return web3.utils.fromWei(await web3.eth.getBalance(address));
}

async function getLastGasCost()
{

  const activityConfirmedEvents = (await contract.getPastEvents('CommitmentMade', { filter: { staker: account }, fromBlock: 0, toBlock: 'latest' }));//.map(a => { return { type: 'commitmentMade', block: a.blockNumber, ...a.returnValues } });
  gasCost = 0;
  if (!!activityConfirmedEvents && (activityConfirmedEvents.length >0))
  {
    const hash = activityConfirmedEvents[activityConfirmedEvents.length-1].transactionHash;
    const tx = await web3.eth.getTransaction(hash);
    const receipt = await web3.eth.getTransactionReceipt(hash);
    gasCost = web3.utils.fromWei(BN(tx.gasPrice).times(BN(receipt.gasUsed)).toString());
  }
  return gasCost
}

function nodeSumary(node)
{
  return (({ stakerAddress, stakerBalance,workerAddress,workerBalance,workerState,lastConfirmationCost,availableForWithdraw }) => ({ stakerAddress, stakerBalance,workerAddress,workerBalance,workerState,lastConfirmationCost,availableForWithdraw  }))(node);
}

async function checkNodeState()
{
  const nodeInfo = await getNodeInfo();
  if (nodeInfo.lastActivePeriod>nodeInfo.currentPeriod) 
  {
    telegrambot("Everything OK!",nodeSumary(nodeInfo))
  } else
  {
    telegrambot("Something went wrong ...",nodeSumary(nodeInfo))
    setTimeout(checkNodeState, 3600000); //3600000 = 1 hour
  }
}

checkNodeState().then(result => {
  // ...
}).catch(error => {
  // if you have an error
})





