const IndexedCSV = require('./IndexedCSV.js');
const HistoricalMarketPriceCombined = require('./HistoricalMarketPriceCombined.js');
const HistoricalMarketPrice = require('./HistoricalMarketPrice.js');
const fsp = require('fs').promises;
const Pack = require('./Pack.js');

const debug = require('./Debug.js')('HistoricalMarket');

const RAWINTERVALS = [
	5 * 60 * 1000,
	15 * 60 * 1000,
	30 * 60 * 1000,
	60 * 60 * 1000,
	2 * 60 * 60 * 1000,
	4 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000,
	24 * 60 * 60 * 1000,
	7 * 24 * 60 * 60 * 1000,
];

const INTERVALS = {
	MIN5: RAWINTERVALS[0],
	MIN15: RAWINTERVALS[1],
	MIN30: RAWINTERVALS[2],
	HOUR1: RAWINTERVALS[3],
	HOUR2: RAWINTERVALS[4],
	HOUR4: RAWINTERVALS[5],
	HOUR12: RAWINTERVALS[6],
	DAY1: RAWINTERVALS[7],
	WEEK1: RAWINTERVALS[8],
};

class HistoricalMarket extends IndexedCSV {
	constructor(params) {
		super(params);

		// this._timeFeatures = [];
		this._pricesCache = {};
		this._pricesCacheKeys = [];
		this._combinedCache = {};
		this._mostRecentReadTime = null;

		this._lastSkipFrom = null;
		this._lastSkipTo = null;

		this._disabledCSV = false;

		this._minInCacheTime = Infinity;
		this._maxInCacheTime = -Infinity;

		this.RAWINTERVALS = RAWINTERVALS;

		this._doNotCheckIntergrity = false;
	}

	/**
	 * Disable csv file, so prices are loaded from dat only
	 * @return {[type]} [description]
	 */
	disableCSV() {
		this._disabledCSV = true;
	}

	getStartTime() {
		return (this._minInCacheTime == Infinity) ? null : this._minInCacheTime;
	}

	getEndTime() {
		return (this._maxInCacheTime == -Infinity) ? null : this._maxInCacheTime;
	}

	getMinIntervalPointsCount() {
		if (!this._combinedCache || !this._combinedCache[RAWINTERVALS[0]]) {
			return 0;
		}
		return Object.keys(this._combinedCache[RAWINTERVALS[0]]).length;
	}

	cleanUpPricesCache() {
		const keepMax = 1000;
		if (this._pricesCacheKeys.length < keepMax) {
			return;
		}

		const deletedKeys = this._pricesCacheKeys.splice(0, this._pricesCacheKeys.length - keepMax);
		for (let key of deletedKeys) {
			delete this._pricesCache[key];
		}
	}

	getLastReadPrice() {
		return this._pricesCache[this._pricesCacheKeys[this._pricesCacheKeys.length - 1]];
	}

	getCachedPriceClosestToTime(time) {
		let minDiff = Infinity;
		let minDiffI = null;
		for (let i = 0; i < this._pricesCacheKeys.length; i++) {
			if ( Math.abs(parseInt(this._pricesCacheKeys[i], 10) - time) < minDiff ) {
				minDiff = Math.abs(parseInt(this._pricesCacheKeys[i], 10) - time);
				minDiffI = i;
			}
		}

		if (minDiffI === null) {
			throw new Error('no getCachedPriceClosestToTime found');
		}

		return this._pricesCache[this._pricesCacheKeys[minDiffI]];
	}

	async prepareToBeSaved(maxWeeks = null) {
		/// 1st - read very first price from the csv file
		debug('Loading data to be saved to cache file');

		const firstIndex = await this.getFirstIndex();
		debug('First time index is %d', firstIndex);

		const lastIndex = await this.getLastIndex();
		debug('Last time index is %d', lastIndex);

		/// move first index to longest interval to future and start calculation
		const firstPeriodIndex = firstIndex + RAWINTERVALS[RAWINTERVALS.length - 1];

		const firstPrice = await this.getPriceAt(firstPeriodIndex);
		debug('First price is %p', firstPrice);

		let combined = await firstPrice.getCombinedPrice(HistoricalMarket.INTERVALS.WEEK1);
		debug('First combined top interval is is %p', combined);

		let maxN = (maxWeeks ? maxWeeks : Infinity);
		let curN = 0;
		do {
			let nextCombined = await combined.getNext();
			debug('nextCombined %p', nextCombined);
			if (!nextCombined) {
				debug('Data missed after %p', combined);
				let p = await this.getNextPrice();
				nextCombined = await p.getCombinedPrice(HistoricalMarket.INTERVALS.WEEK1);
			}

			combined = nextCombined;
			curN++;

			debug('Calculated combined %p %d', combined, combined.time);

			await new Promise((res)=>{ setTimeout(res, 1000); }); // need this for gargage collector
		} while(combined && curN < maxN && combined.time < lastIndex);
	}

	getTopLevelIntervals() {
		let ret = [];
		for (let time in this._combinedCache[INTERVALS.WEEK1]) {
			ret.push(this._combinedCache[INTERVALS.WEEK1][time]);
		}

		return ret;
	}

	async saveToFile(filename) {
		const fp =  await fsp.open(filename, 'w');
		for (let time in this._combinedCache[INTERVALS.WEEK1]) {
			if (this._combinedCache[INTERVALS.WEEK1][time].isFull()) {
				const uint8Array = this._combinedCache[INTERVALS.WEEK1][time].toUint8Array();
				// console.error('write chunk', uint8Array[0], uint8Array[1], uint8Array[2], uint8Array[3] );
				await fp.write(uint8Array, 0, uint8Array.length); // Uint8Array
			}
		}
		await fp.close();
	}

	async readFromFile(filename) {
		const fp =  await fsp.open(filename, 'r');
		const stats = await fp.stat();
		const size = stats.size;

		let offset = 0;
		do {
			// 1st - read chunk size
			let sizeChunkBinary = new Uint8Array(4);
			await fp.read(sizeChunkBinary, 0, 4, offset);
			const unpacked = Pack.unpack('>I', sizeChunkBinary);
			let chunkSize = unpacked[0];

			let chunkBinary = new Uint8Array(chunkSize);
			await fp.read(chunkBinary, 0, chunkSize, offset);

			let priceCombined = HistoricalMarketPriceCombined.fromUint8Array(chunkBinary, this);
			// console.log(Math.floor(priceCombined.time / 1000000), priceCombined.time);
			// if (Math.floor(priceCombined.time / 1000000) == 15282) {
			// 	console.log('1528209600000 good'+priceCombined.time );
			// }
			// if (priceCombined.time == 1527724800000) {
			// 	console.log(priceCombined._prices[5]._prices[1]._prices[0]._prices[0]._prices[1]._prices[1]);
			// }


			offset+=chunkSize;
		} while(offset < size);

		await fp.close();
	}

	async getPriceAt(time) {
		if (this._pricesCache[time]) {
			// debug('price from cache, %p', this._pricesCache[time]);
			// console.log('price cached', new Date(time), time);
			return this._pricesCache[time];
		}

		// if there's combined price cached for MIN5 for this time - get price out of it
		const fromTime = Math.floor(time / RAWINTERVALS[0]) * RAWINTERVALS[0];
		if (this._combinedCache[RAWINTERVALS[0]] && this._combinedCache[RAWINTERVALS[0]][fromTime]) {
			// debug('price from combinedPrice cache, %p', this._combinedCache[RAWINTERVALS[0]][fromTime]);
			// debug('getting price from combinedPrice cache: '+(new Date(fromTime)));
			return this._combinedCache[RAWINTERVALS[0]][fromTime];
		}

		if (this._disabledCSV) {
			throw new Error('Out of range, no data for this time in dat file');
		}

		// if there's none - lo

		// debug('getting price from csv file: '+(new Date(fromTime))+'  '+fromTime);
		if (this._lastSkipTo !== null && this._lastSkipFrom !== null && time > this._lastSkipFrom && time < this._lastSkipTo) {
			// debug('Getting sure skipped data %d', time);
			return null;
		}

		let row = null;
		if (this._mostRecentReadTime && (time <= (this._mostRecentReadTime + 60*1000) && time > (this._mostRecentReadTime) )) {
			// asked for next minute price
			// console.log('reading as next', new Date(time), time);
			row = await this.getNextRow();
		} else {
			// debug('trying to load price row directly from csv for time %d', time);
			row = await this.getRowByIndex(time);

			if (row && row._index && row._index < (time - 60*1000)) {
				// we are on skipped data
				// debug('Looks that we are on skip, from %d', row._index);
				let nextRow = await this.getNextRow();
				// debug('Looks that we are on skip, to %d', nextRow._index);
				if (nextRow) {
					this._lastSkipFrom = row._index;
					this._lastSkipTo = nextRow._index;
				}
			}
		}

		if (!row || !row._index) {
			return null;
		}

		let price = new HistoricalMarketPrice({row: row, historicalMarket: this});

		if (price.isValid()) {
			// this._pricesCache[price.time] = price;
			this._pricesCache[time] = price;
			this._pricesCacheKeys.push(time);
			this._mostRecentReadTime = price.time;

			return price;
		} else {
			return null;
		}
	}

	async getNextPrice() {
		let row = await this.getNextRow();
		if (!row) {
			return null;
		}

		let price = new HistoricalMarketPrice({row: row, historicalMarket: this});
		this._pricesCache[price.time] = price;
		this._pricesCacheKeys.push(price.time);
		this._mostRecentReadTime = price.time;

		return price;
	}

	/**
	 * Use this function to add 5min price after everything is loaded from files (for real time updating)
	 * @param  {[type]} data [description]
	 * @return {[type]}      [description]
	 */
	async pushLowestCombinedIntervalRAWAndRecalculateParents(data) {
		this._doNotCheckIntergrity = true;

		const prices = [];
		const interval = RAWINTERVALS[0];

		data.time = Math.floor(data.time / interval) * interval;

		const fromTime = data.time;

		const price = new HistoricalMarketPrice({row: data, historicalMarket: this});
		prices.push(price);

		const combinedPrice = new HistoricalMarketPriceCombined({prices: prices, historicalMarket: this, interval: interval, time: fromTime});
		combinedPrice.setPriceDirectly(data.price);

		return await this.pushCombinedPriceAndRecalculateParents(combinedPrice);
	}

	async pushCombinedPriceAndRecalculateParents(combinedPrice) {
		this.pushCombinedPriceToCache(combinedPrice);
		let higherPrice = await combinedPrice.getHigherInterval();
		// let updated = higherPrice.mergeUpdatedChild(combinedPrice);

		let previousPrice = combinedPrice;

		do {
			// console.log('mergeUpdatedChild', higherPrice.time, new Date(higherPrice.time));
			higherPrice.mergeUpdatedChild(previousPrice);
			higherPrice.reCalcValues();

			previousPrice = higherPrice;
			higherPrice = await higherPrice.getHigherInterval();
		} while(higherPrice);

		// const priceTime = combinedPrice.time;
		// const intervalIndex = RAWINTERVALS.indexOf(combinedPrice.interval);

		// for (let i = intervalIndex + 1; i < RAWINTERVALS.length; i++) {
		// 	const interval = RAWINTERVALS[i];
		// 	const fromTime = Math.floor(priceTime / interval) * interval;

		// 	if (!this._combinedCache[combinedPrice.interval]) {
		// 		this._combinedCache[combinedPrice.interval] = {};
		// 	}
		// 	if (!this._combinedCache[interval][fromTime]) {

		// 	}
		// }
	}

	pushCombinedPriceToCache(combinedPrice) {
		if (!this._combinedCache[combinedPrice.interval]) {
			this._combinedCache[combinedPrice.interval] = {};
		}
		this._combinedCache[combinedPrice.interval][combinedPrice.time] = combinedPrice;
		if (this._maxInCacheTime < combinedPrice.time) {
			this._maxInCacheTime = combinedPrice.time;
		}
		if (this._minInCacheTime > combinedPrice.time) {
			this._minInCacheTime = combinedPrice.time;
		}
	}

	async getCombinedPrice(time, interval) {
		// debug('getCombinedPrice %d %d', time, interval);
		const fromTime = Math.floor(time / interval) * interval;
		const toTime = fromTime + interval;

		if (this._combinedCache[interval] && this._combinedCache[interval][fromTime]) {
			debug('combinedPrice from cache, %d %d %p', time, fromTime, this._combinedCache[interval][fromTime]);
			return this._combinedCache[interval][fromTime];
		}

		if (interval == RAWINTERVALS[RAWINTERVALS.length - 1]) {
			debug('top interval: %d %d', time, fromTime);
		}

		// console.error('interval', new Date(time), new Date(fromTime), new Date(toTime), interval);

		const prices = [];
		if (interval != RAWINTERVALS[0]) {
			// asked for not 5mins interval, so lets schedule top level ones
			let lowerInterval = RAWINTERVALS[RAWINTERVALS.indexOf(interval) - 1];
			// console.log('getting lower intervals = ', lowerInterval);

			for (let ft = fromTime; ft < toTime; ft += lowerInterval) {
				let lowerCombined = null;
				try {
					lowerCombined = await this.getCombinedPrice(ft, lowerInterval);
				} catch(e) {
					if (!this._doNotCheckIntergrity) {
						throw e;
					}
				}
				if (lowerCombined) {
					prices.push(lowerCombined);
				}
			}
			// console.log('getting lower intervals = ', lowerInterval, prices.length);
		} else {
			// 5 minutes interval
			//
			// let price = await this.getPriceAt(fromTime);
			// if (price && (price.time >= fromTime && price.time < toTime)) {
			// 	prices.push(price);
			// }

			let nextTime = fromTime;
			do {
				let price = await this.getPriceAt(nextTime);
				if (price && (price.time >= fromTime && price.time < toTime)) {
					prices.push(price);
					// debug('+')
				} else {
					// debug('missed price for time %s %d', new Date(nextTime), nextTime);
					// if (price) {
					// 	debug('%d', price.time);
					// }

					price = this.getCachedPriceClosestToTime(nextTime);
					if (price) {
						// debug('got from cache, %d', price.time);
					}

					// debug('- %d', (Math.abs(price.time - nextTime)));
					prices.push(price);
				}

				nextTime += 60*1000;
			} while(nextTime < toTime);

			if (prices.length != 5) {
				console.log(prices.length);
				throw new Error('Can not cal 5 min interval '+fromTime);
			}
		}

		if (prices.length) {
			const combinedPrice = new HistoricalMarketPriceCombined({prices: prices, historicalMarket: this, interval: interval, time: fromTime});
			if (!this._combinedCache[interval]) {
				this._combinedCache[interval] = {};
			}
			this._combinedCache[interval][fromTime] = combinedPrice;

			this.cleanUpPricesCache();

			return combinedPrice;
		} else {
			return null;
		}

	}
};

HistoricalMarket.INTERVALS = INTERVALS;
HistoricalMarket.RAWINTERVALS = RAWINTERVALS;

// class TimeFeaturesSet {
// 	constructor() {

// 	}
// }

module.exports = HistoricalMarket;