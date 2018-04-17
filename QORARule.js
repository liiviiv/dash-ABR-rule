/**
 * Added by PengHuan on 2018/3/12
 * QORA:QoE-Optimal Rate Adaptation
 * Create a real-time QoE estimate model,and use this model to decide which segment to download
 */
//import MetricsConstants from '../../constants/MetricsConstants';
//import {HTTPRequest} from '../../vo/metrics/HTTPRequest';
//import EventBus from '../../../core/EventBus';
//import Events from '../../../core/events/Events';
let QORARule;

const minBufferLevel = 6;
const maxBufferLevel = 30;
const gama = 0.5;
const k = 0.02;

function QORARuleClass(dashjs) {
    let factory=dashjs.FactoryMaker;
    let SwitchRequest=factory.getClassFactoryByName('SwitchRequest');
    let MetricsModel=factory.getSingletonFactoryByName('MetrcsModel');
    let DashMetrics = factory.getSingletonFactoryByName('DashMetrics');
    //let DashManifestModel = factory.getSingletonFactoryByName('DashManifestModel');
    //let StreamController = factory.getSingletonFactoryByName('StreamController');
    let Debug = factory.getSingletonFactoryByName('Debug');
    
    const context = this.context;
    const log = Debug(context).getInstance().log;

    
    //const mediaPlayerModel = config.mediaPlayerModel;
    //const eventBus = EventBus(context).getInstance();

    let qoraStateDict;
    
    function sign(onenumber) {
        if (onenumber > 0) {
            return 1.0;
        }
        else {
            return 0.0;
        }
    }
    //map the bitrate array to quality array for continuing caculation:
    function mapBitrateToQualityValue(bitrates) {
        let qualityValue;
        for (let i = 0; i < bitrates.length; i++)
        {
            if (bitrates[i] <= 250) {
                qualityValue[i] = 1 - 0.0008 * bitrates[i];
            }
            else if (bitrates[i] <= 500) {
                qualityValue[i] = 1.3 - 0.002 * bitrates[i];
            }
            else if (bitrates[i] <= 1000) {
                qualityValue[i] = 0.5 - 0.0004 * bitrates[i];
            }
            else if (bitrates[i] <= 2000) {
                qualityValue[i] = 0.2 - 0.0001 * bitrates[i];
            }
            else {
                qualityValue[i] = 0;
            }
        }
        return qualityValue;
        //the quality value is between 0 and 1,and quality is better,the value is lower.
    }
    //initial related parameters:
    function getQoraState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let qoraState = qoraStateDict[mediaType];
        if (!qoraState) {
            const qoraState = {};
            const mediaInfo = rulesContext.getMediaInfo();
            const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
            let qualityValue = mapBitrateToQualityValue(bitrates);
            qoraState.bitrates = bitrates;
            qoraState.qualityValue = qualityValue;
            qoraState.lastChoosenQuality = 0;
            qoraState.currentSegmentIndex = 1;
            qoraState.timeofInitialDelay = 0;//initial delay parameter
            qoraState.numOfStall = 0;//stall parameter
            qoraState.durationOfStall = 0;//stall parameter
            qoraState.numOfSameQualityBefore = 0;//level variation parameter
            qoraState.impOfQuality = 0;//level variation parameter:impairment caused by continuous low quality
            qoraState.impOfSwitch = 0;//level variation parameter:impairment caused by quality switch
            qoraStateDict[mediaType] = qoraState;
        }
        return qoraState;
    }
    //update related parameters:
    function updateQoraState(qoraState, index, paramsOfID, paramsOfST, paramsOfLV) {
        let curChoosenQuality = qoraState.qualityValue[index];
        if (Math.abs(curChoosenQuality - qoraState.lastChoosenQuality) < 0.05) {
            qoraState.numOfSameQualityBefore++;
        }
        else {
            qoraState.numOfSameQualityBefore = 0;
        }
        qoraState.lastChoosenQuality = curChoosenQuality;
        qoraState.currentSegmentIndex++;
        qoraState.timeofInitialDelay = paramsOfID.Tid;
        qoraState.numOfStall = paramsOfST.Nst;
        qoraState.durationOfStall = paramsOfST.Dst;
        qoraState.impOfQuality = paramsOfLV.Iq;
        qoraState.impOfSwitch = paramsOfLV.Is;
    }
    //calculate the impairment value caused by initial delay:
    function calculateInitialDelay(currentBufferLevel, throughput, bitrate, qoraState) {
        let Iid = 0;//inpairment caused by initial delay
        let Tid = qoraState.timeofInitialDelay;//get current time of initial delay
        if (currentBufferLevel < minBufferLevel) {
            Iid = 3.2 * (Tid + bitrate / throughput);
            Tid += bitrate / throughput;
        }
        return {Tid: Tid,Iid: Iid};
    }
    //calculate the impairment value caused by stall:
    function calculateStall(currentBufferLevel, throughput, bitrate, segmentLength, qoraState) {
        let Ist = NaN;//impairment caused by stall
        let threshold = gama * minBufferLevel + (1 - gama) * maxBufferLevel;
        let Tst = threshold + bitrate / throughput - segmentLength;//calculate the threshold that may cause stall
        let Nst = qoraState.numOfStall;
        let Dst = qoraState.durationOfStall;
        if (currentBufferLevel > minBufferLevel && currentBufferLevel < Tst) {
            Nst++;
            Dst += bitrate / throughput;
        }
        else if (currentBufferLevel < minBufferLevel) {
            Dst += bitrate / throughput;
        }
        Ist = 3.8 * Dst + 4.2 * Nst - 2.6 * Math.sqrt(Dst * Nst);
        return {Nst: Nst,Dst: Dst,Ist: Ist};
    }
    //calculate the impairment value caused by video quality variation:
    function calculateLevelVariation(qualityValue, segmentLength, qoraState) {
        let Ilv = NaN;//ImpairmentOfLevelVariation
        let index = qoraState.currentSegmentIndex;//current segment index
        let Iq = qoraState.impOfQuality;//current impairment caused by continuous low quality
        let Is = qoraState.impOfSwitch;//current impairment caused by quality drop
        let lastQuality = qoraState.lastChoosenQuality;//the quality value of last choosen segment
        Iq = ((index - 1) * Iq + qualityValue * Math.exp(k * segmentLength * qoraState.numOfSameQualityBefore)) / index;
        Is = ((index - 1) * Is + Math.SQRT2(qualityValue - lastQuality) * sign(lastQuality - qualityValue)) / index;
        Ilv = 75.6 * Iq + 48.2 * Is;
        return {Iq: Iq,Is: Is,Ilv: Ilv};
    }
    //caculate the QoE value of current segment:
    function caculateQoE(Iid, Ist, Ilv) {
        return 100 - Iid - Ist - Ilv + 0.17 * Iid * Math.sqrt(Ist + Ilv) + 0.31 * Math.sqrt(Ist * Ilv);
    }
    function getMaxIndex(rulesContext) {
        let dashMetrics = DashMetrics(context).getInstance();
        let metricsModel = MetricsModel(context).getInstance();
        const switchRequest = SwitchRequest(context).create();
        const mediaType = rulesContext.getMediaType();
        const bufferLevel = dashMetrics.getCurrentBufferLevel(metricsModel.getReadOnlyMetricsFor(mediaType));
        const abrController = rulesContext.getAbrController();
        const throughputHistory = abrController.getThroughputHistory();
        const streamInfo = rulesContext.getStreamInfo();
        const isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        const latency = throughputHistory.getAverageLatency(mediaType);
        const streamProcessor = rulesContext.getStreamProcessor();
        const fragmentDuration = streamProcessor.getCurrentRepresentationInfo().fragmentDuration;
        
        const qoraState = getQoraState(rulesContext);

        switchRequest.reason = switchRequest.reason || {};

        let qualityValue = qoraState.qualityValue;
        let bitrates=qoraState.bitrates;
        let index = NaN;
        let maxQualityValue = NaN;
        let paramsOfID = {};
        let paramsOfST = {};
        let paramsOfLV = {};
        for (let i = 0; i < bitrates.length; ++i)
        {
            paramsOfID = calculateInitialDelay(bufferLevel,throughput,bitrates[i]);
            paramsOfST = calculateStall(bufferLevel,throughput,bitrates[i],fragmentDuration,qoraState);
            paramsOfLV = calculateLevelVariation(qualityValue[i],fragmentDuration,qoraState);
            let QoEvalue = caculateQoE(paramsOfID.Iid,paramsOfST.Ist,paramsOfLV.Ilv);
            if (isNaN(maxQualityValue) && QoEvalue > maxQualityValue) {
                maxQualityValue = QoEvalue;
                index = i;
            }
        }
        switchRequest.quality = index;
        switchRequest.reason = {throughput: throughput,latency: latency};
        log('********QORA:current choosen bitrate:' + bitrates[index] + ',currentQoEValue:' + maxQualityValue + '********');
        updateQoraState(qoraState,index,paramsOfID,paramsOfST,paramsOfLV);
        //write choosen bitrate to the txt file:
        /*
        var fso=new ActiveXObject(Scripting.FileSystemObject);
        var f=fso.createtextfile("D:\bitrate.txt",8,true);
        f.writeLine(currentSegmentIndex+":"+bitrates[index]);
        f.close();
        */
        return switchRequest;
    }
    /*
    function reset() {
        qoraStateDict = {};
    }*/
    const instance = {
        getMaxIndex: getMaxIndex
    };
    return instance;
}

QORARuleClass.__dashjs_factory_name = 'QORARule';
QORARule = dashjs.FactoryMaker.getClassFactory(QORARuleClass);
//export default FactoryMaker.getClassFactory(QORARule);