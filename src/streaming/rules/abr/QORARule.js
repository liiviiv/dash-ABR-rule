/**
 * Added by PengHuan on 2018/3/25
 * QORA:QoE-Optimal Rate Adaptation
 * Create a real-time QoE estimate model,and use this model to decide which segment to download
 */

import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import Debug from '../../../core/Debug';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import MetricsConstants from '../../constants/MetricsConstants';
import {HTTPRequest} from '../../vo/metrics/HTTPRequest';

const minBufferLevel = 4;
const maxBufferLevel = 25;
const gama = 0.4;
const k = 0.02;
const QORA_STATE_ONEBITRATE   = 0;
const QORA_STATE_STARTUP      = 1;
const QORA_STATE_STEADY       = 2;
//qoraState.state=0:there are only one available bitrate,no need to use ABR algorithm,just return the default switchRequest;
//qoraState.state=1:there are several bitrates,need to use ABR algorithm to decide which bitrate segment to download.
function QORARule(config) {
    const context = this.context;
    const dashMetrics = config.dashMetrics;
    const metricsModel = config.metricsModel;
    //const mediaPlayerModel = config.mediaPlayerModel;
    const log = Debug(context).getInstance().log;
    const eventBus = EventBus(context).getInstance();

    let instance,
        qoraStateDict;

    function setup() {
        resetInitialSettings();

        //open some listener when create the QORARule instance:
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
        eventBus.on(Events.METRIC_ADDED, onMetricAdded, instance);
    }

    function sign(onenumber) {
        if (onenumber > 0) {
            return 1.0;
        }
        else {
            return 0.0;
        }
    }

    //map the bitrate array to quality value(VQM) array for continuing caculation:
    //Attention:bitrates stand for the fragment's bitrate in bps,need transformed firstly
    function mapBitrateToQualityValue(bitrates) {
        let qualityValue = [];
        let bitratesInkbps = bitrates.map(b => b / 1000);
        //let bitrates_indeed = [200, 400, 600, 800, 1000, 1500, 2500, 4000, 8000, 12000];
        for (let i = 0; i < bitratesInkbps.length; i++) {
            if (bitratesInkbps[i] <= 250) {
                qualityValue[i] = 1 - 0.0008 * bitratesInkbps[i];
            }
            else if (bitratesInkbps[i] <= 500) {
                qualityValue[i] = 1.3 - 0.002 * bitratesInkbps[i];
            }
            else if (bitratesInkbps[i] <= 1000) {
                qualityValue[i] = 0.5 - 0.0004 * bitratesInkbps[i];
            }
            else if (bitratesInkbps[i] <= 2000) {
                qualityValue[i] = 0.2 - 0.0001 * bitratesInkbps[i];
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
        const abrController = rulesContext.getAbrController();
        const mediaInfo = rulesContext.getMediaInfo();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        let qoraState = qoraStateDict[mediaType];
        //if the video/audio qoraState doesn't exist,then initialize it:
        if (!qoraState) {
            const initialState = {};
            //initialize some info that video and audio both have:
            initialState.currentSegmentIndex = 1;
            initialState.bitrates = bitrates;
            initialState.lastChoosenQuality = abrController.getQualityFor(mediaType);
            if (bitrates.length === 1) {
                initialState.state = QORA_STATE_ONEBITRATE;
            } else {
                initialState.state = QORA_STATE_STARTUP;
                let qualityValue = mapBitrateToQualityValue(bitrates);
                initialState.qualityValue = qualityValue;
                initialState.timeofInitialDelay = 0;//initial delay parameter
                initialState.numOfStall = 0;//stall parameter
                initialState.durationOfStall = 0;//stall parameter
                initialState.numOfSameQualityBefore = 0;//level variation parameter
                initialState.impOfQuality = 0;//level variation parameter:impairment caused by continuous low quality
                initialState.impOfSwitch = 0;//level variation parameter:impairment caused by quality switch
            }
            qoraStateDict[mediaType] = initialState;
            return initialState;
        }
        //if the qoraState has existed,then update its state,bitrates,qualityValue,currentSegmentIndex:
        else {
            qoraState.currentSegmentIndex++;
            qoraState.bitrates = bitrates;
            if (mediaType === 'video') {
                let newQuality = abrController.getQualityFor(mediaType);
                let oldQuality = qoraState.lastChoosenQuality;
                if (newQuality === oldQuality) {
                    qoraState.numOfSameQualityBefore++;
                } else {
                    qoraState.numOfSameQualityBefore = 0;
                }
                if (qoraState.bufferLevel < minBufferLevel && qoraState.lastSegmentRequestTimeMs && qoraState.lastSegmentFinishTimeMs) {
                    qoraState.timeofInitialDelay += (qoraState.lastSegmentFinishTimeMs - qoraState.lastSegmentRequestTimeMs) / 1000;
                }
            }
            //qoraState.lastChoosenQuality = abrController.getQualityFor(mediaType);
            if (bitrates.length === 1) {
                qoraState.state = QORA_STATE_ONEBITRATE;
            } else {
                //qoraState.state = QORA_STATE_STEADY;
                qoraState.qualityValue = mapBitrateToQualityValue(bitrates);
            }
            return qoraState;
        }
    }

    //update related parameters,should be called when qora rule decide which quality to download or when a segment downloading finished??
    function updateQoraState(qoraState, quality) {
        let index;
        if (quality === SwitchRequest.NO_CHANGE) {
            index = qoraState.lastChoosenQuality;
        } else {
            index = quality;
        }
        let qoeParams = caculateQoE(qoraState, index);
        qoraState.qoe = qoeParams.qoe;
        //qoraState.timeofInitialDelay = qoeParams.paramsOfID.Tid;
        qoraState.numOfStall = qoeParams.paramsOfST.Nst;
        qoraState.durationOfStall = qoeParams.paramsOfST.Dst;
        qoraState.impOfQuality = qoeParams.paramsOfLV.Iq;
        qoraState.impOfSwitch = qoeParams.paramsOfLV.Is;
    }

    //calculate the impairment value caused by initial delay:
    function calculateInitialDelay(qoraState, index) {
        let Iid = 0;//inpairment caused by initial delay
        let Tid = qoraState.timeofInitialDelay;//get current time of initial delay
        if (qoraState.bufferLevel < minBufferLevel) {
            Iid = 3.2 * (Tid + qoraState.bitrates[index] / (1000 * qoraState.throughput));
            Tid += (qoraState.bitrates[index] * qoraState.fragmentDuration) / (1000 * qoraState.throughput);
        }
        return {Tid: Tid, Iid: Iid};
    }

    //calculate the impairment value caused by stall:
    function calculateStall(qoraState, index) {
        let Ist = 0;//impairment caused by stall
        let threshold = gama * minBufferLevel + (1 - gama) * maxBufferLevel;
        let Tst = threshold + qoraState.bitrates[index] / (1000 * qoraState.throughput) - qoraState.fragmentDuration;//calculate the threshold that may cause stall
        let Nst = qoraState.numOfStall;
        let Dst = qoraState.durationOfStall;
        if (qoraState.currentSegmentIndex > minBufferLevel / qoraState.fragmentDuration) {
            if (qoraState.bufferLevel > minBufferLevel && qoraState.bufferLevel < Tst) {
                Nst++;
                for (let i = 0; i < minBufferLevel / qoraState.fragmentDuration; i++) {
                    Dst += (qoraState.bitrates[0] * qoraState.fragmentDuration) / (1000 * qoraState.throughput);
                }
            }
            else if (qoraState.bufferLevel < minBufferLevel) {
                Dst += (qoraState.bitrates[index] * qoraState.fragmentDuration) / (1000 * qoraState.throughput);
            }
            Ist = 3.8 * Dst + 4.2 * Nst - 2.6 * Math.sqrt(Dst * Nst);
        }
        return {Nst: Nst, Dst: Dst, Ist: Ist};
    }

    //calculate the impairment value caused by video quality variation:
    function calculateLevelVariation(qoraState, index) {
        let Ilv = 0;//ImpairmentOfLevelVariation
        let segmentIndex = qoraState.currentSegmentIndex;//current segment index
        let Iq = qoraState.impOfQuality;//current impairment caused by continuous low quality
        let Is = qoraState.impOfSwitch;//current impairment caused by quality drop
        let lastQuality = qoraState.lastChoosenQuality;//the quality value of last choosen segment
        Iq = ((segmentIndex - 1) * Iq + qoraState.qualityValue[index] * Math.exp(k * qoraState.fragmentDuration * qoraState.numOfSameQualityBefore)) / segmentIndex;
        Is = ((segmentIndex - 1) * Is + Math.pow(qoraState.qualityValue[index] - qoraState.qualityValue[lastQuality], 2) * sign(qoraState.qualityValue[index] - qoraState.qualityValue[lastQuality])) / segmentIndex;
        Ilv = 75.6 * Iq + 48.2 * Is;
        return {Iq: Iq, Is: Is, Ilv: Ilv};
    }

    //caculate the QoE value of current segment:
    function caculateQoE(qoraState, index) {
        let paramsOfID_tmp = calculateInitialDelay(qoraState, index);
        let paramsOfST_tmp = calculateStall(qoraState, index);
        let paramsOfLV_tmp = calculateLevelVariation(qoraState, index);
        let Iid = paramsOfID_tmp.Iid;
        let Ist = paramsOfST_tmp.Ist;
        let Ilv = paramsOfLV_tmp.Ilv;
        let qoe = 100 - Iid - Ist - Ilv + 0.17 * Iid * Math.sqrt(Ist + Ilv) + 0.31 * Math.sqrt(Ist * Ilv);
        return {qoe: qoe,paramsOfID: paramsOfID_tmp,paramsOfST: paramsOfST_tmp,paramsOfLV: paramsOfLV_tmp};
    }

    function getMaxIndex(rulesContext) {
        const mediaInfo = rulesContext.getMediaInfo();
        const switchRequest = SwitchRequest(context).create();
        const mediaType = rulesContext.getMediaType();
        const abrController = rulesContext.getAbrController();
        const throughputHistory = abrController.getThroughputHistory();
        const streamInfo = rulesContext.getStreamInfo();
        const isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        const streamProcessor = rulesContext.getStreamProcessor();
        const fragmentDuration = streamProcessor.getCurrentRepresentationInfo().fragmentDuration;
        //const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        switchRequest.reason = switchRequest.reason || {};
        const qoraState = getQoraState(rulesContext);

        const bufferLevel = dashMetrics.getCurrentBufferLevel(metricsModel.getReadOnlyMetricsFor(mediaType));
        const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        const safeThroughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);
        const latency = throughputHistory.getAverageLatency(mediaType);
        let quality;

        switchRequest.reason.throughput = throughput;
        switchRequest.reason.latency = latency;
        switchRequest.reason.bufferLevel = bufferLevel;
        qoraState.throughput = safeThroughput;
        qoraState.bufferLevel = bufferLevel;
        qoraState.fragmentDuration = fragmentDuration;

        //if there is only one bitrate,no need to use qora rule and update related params:
        if (qoraState.state === QORA_STATE_ONEBITRATE) {
            log('Qora ABR rule invoked for media type \'' + mediaType + '\' with only one bitrate.');
            //log('***QoraRule:current chosen bitrate index:' + switchRequest.quality + ',bufferLevel:' + bufferLevel + ',throughput:' + throughput + ',QoE:' + qoraState.qoe + '.***');
            return switchRequest;
        }

        // still starting up - not enough information,so choose the default switchRequest:
        if (isNaN(throughput)) { // isNaN(throughput) === isNaN(safeThroughput) === isNaN(latency)
            log('***QoraRule:fragmentIndex:' + qoraState.currentSegmentIndex + ',quality:' + qoraState.lastChoosenQuality + ',bufferLevel:' + bufferLevel + ',bandwidth:' + throughput + ',QoE:' + qoraState.qoe + '.***');
            return switchRequest;
        }

        switch (qoraState.state) {
            case QORA_STATE_STARTUP:
                quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, latency);

                switchRequest.quality = quality;
                switchRequest.reason.throughput = safeThroughput;

                if (!isNaN(qoraState.lastSegmentDurationS) && bufferLevel >= qoraState.lastSegmentDurationS && bufferLevel >= minBufferLevel) {
                    qoraState.state = QORA_STATE_STEADY;
                }
                log('***QoraRule:startup state.');
                break;

            case QORA_STATE_STEADY:
                let bitrates = qoraState.bitrates;
                let index = NaN;
                let maxQualityValue = NaN;
                for (let i = 0; i < bitrates.length; ++i) {
                    let QoEparams = caculateQoE(qoraState, i);
                    let QoEvalue_tmp = QoEparams.qoe;
                    if (isNaN(maxQualityValue) || QoEvalue_tmp > maxQualityValue) {
                        maxQualityValue = QoEvalue_tmp;
                        index = i;
                    }
                }
                switchRequest.quality = index;
                log('***QoraRule:steady state.');
                if (bufferLevel < minBufferLevel) {
                    qoraState.state = QORA_STATE_STARTUP;
                }
                break;
            default:
                // should not arrive here, try to recover
                log('***QoraRule invoked in bad state.***');
                switchRequest.quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, latency);
                switchRequest.reason.throughput = safeThroughput;
                switchRequest.reason.latency = latency;
                qoraState.state = QORA_STATE_STARTUP;
        }
        updateQoraState(qoraState, switchRequest.quality);
        qoraState.lastChoosenQuality = switchRequest.quality;
        log('***QoraRule:fragmentIndex:' + qoraState.currentSegmentIndex + ',quality:' + switchRequest.quality + ',bufferLevel:' + bufferLevel + ',bandwidth:' + throughput + ',QoE:' + qoraState.qoe + '.***');
        qoraStateDict[mediaType] = qoraState;
        return switchRequest;
    }

    function onMediaFragmentLoaded(e) {
        if (e && e.chunk && e.chunk.mediaInfo) {
            const qoraState = qoraStateDict[e.chunk.mediaInfo.type];
            if (qoraState && qoraState.state !== QORA_STATE_ONEBITRATE) {
                qoraState.lastSegmentStart = e.chunk.start;
                qoraState.lastSegmentDurationS = e.chunk.duration;
                qoraState.lastChoosenQuality = e.chunk.quality;
            }
        }
    }

    function onMetricAdded(e) {
        if (e && e.metric === MetricsConstants.HTTP_REQUEST && e.value && e.value.type === HTTPRequest.MEDIA_SEGMENT_TYPE && e.value.trace && e.value.trace.length) {
            const qoraState = qoraStateDict[e.mediaType];
            if (qoraState && qoraState.state !== QORA_STATE_ONEBITRATE) {
                qoraState.lastSegmentRequestTimeMs = e.value.trequest.getTime();
                qoraState.lastSegmentFinishTimeMs = e.value._tfinish.getTime();
            }
        }
    }

    //when the player is in the process of seeking,need to change qoraState.state to 0,so that use getQualityForBitrate() to start quickly
    function onPlaybackSeeking() {
        for (const mediaType in qoraStateDict) {
            if (qoraStateDict.hasOwnProperty(mediaType)) {
                const qoraState = qoraStateDict[mediaType];
                if (qoraState.state !== QORA_STATE_ONEBITRATE) {
                    qoraState.state = QORA_STATE_STARTUP;
                    //clearBolaStateOnSeek(bolaState);
                }
            }
        }
    }

    function resetInitialSettings() {
        qoraStateDict = {};
    }

    function reset() {
        resetInitialSettings();
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.off(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
        eventBus.off(Events.METRIC_ADDED, onMetricAdded, instance);
    }

    instance = {
        getMaxIndex: getMaxIndex,//a function that can be used outside to get current quality
        reset: reset
    };
    setup();//if do not use this function,then qoraStateDict doesn't exist.
    return instance;
}

QORARule.__dashjs_factory_name = 'QORARule';
export default FactoryMaker.getClassFactory(QORARule);

