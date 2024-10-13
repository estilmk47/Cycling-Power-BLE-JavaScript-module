class RevolutionData{
    constructor(){
        this.nonZeroValue = 0;
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
    reset(){
        this.prevStaleness = true;
        this.prevRevs = null;
        this.prevTime = null;
    }
}

class Bike {
    // Documentation: https://www.bluetooth.com/specifications/specs/gatt-specification-supplement/
    // PageNr: 84
    static FLAG_FIELD = Object.freeze({
        PedalPowerBalance:              {index: 0,  fieldSize: 1},
        PedalPowerBalanceReference:     {index: 1,  fieldSize: 0}, 
        AccumulatedTorque:              {index: 2,  fieldSize: 2}, // -> 1/32 Newton-meter
        AccumulatedTorqueSource:        {index: 3,  fieldSize: 0},
        RevolutionData:                 {index: 4,  fieldSize: 6}, // Struct: [0:4] Cum -> revolutions, [5:6] Time -> 1/2048 s
        CrankRevolutionData:            {index: 5,  fieldSize: 4}, // Struct: [0:2] CumCrank -> revolutions, [3:4] Time -> 1/1024 s
        ExtremeForceMagnitudes:         {index: 6,  fieldSize: 4}, 
        ExtremeTorqueMagnitudes:        {index: 7,  fieldSize: 4}, 
        ExtremeAnglesPresent:           {index: 8,  fieldSize: 3}, 
        TopDeadSpotAngle:               {index: 9,  fieldSize: 2}, 
        BottomDeadSpotAngle:            {index: 10, fieldSize: 2}, 
        AccumulatedEnergy:              {index: 11, fieldSize: 2}, // -> kJ
        OffsetCompensationIndicator:    {index: 12, fieldSize: 0}
        /* Unused flags 13 - 15 */
    });

    static MODES = Object.freeze({
        RAW: 'raw',
        FILTERED: 'filtered'
    });

    #mode = Bike.MODES.RAW;
    #connecting = false;
        
    #powerAvailable = false;
    #speedAvailable = false;
    #cadenceAvailable = false;

    #notificationTimestamp = null;
    #power = 0;
    #accumulatedEnergy = 0;
    #accumulatedDistance = 0;
    #speed = 0;
    #cadence = 0;  //rpm

    constructor(){
        this.self = null; // The user may want to tamper with this (It feels strange, but we'll allow it)
        this.name = null;
        
        //BLE CHARACTERISTIC VALUES
        this.wheelRevolutionData = new RevolutionData();
        this.crankRevolutionData = new RevolutionData();
    }

    get isConnected() { if(this.self){ return true; } return false; }
    get mode(){ return this.#mode; }
    get connecting(){ return this.#connecting; }

    get powerAvailable(){ return this.#powerAvailable; }
    get speedAvailable(){ return this.#speedAvailable; }
    get cadenceAvailable(){ return this.#cadenceAvailable; }
    get timestamp(){ return this.#notificationTimestamp; }


    #powerBuffer = [];
    #powerFilter = [3, 2, 1];
    get power(){
        if (this.#mode == Bike.MODES.FILTERED){
            return this.#weightedAverage(this.#powerBuffer, this.#powerFilter);
        }
        return this.#power;
    }

    #speedBuffer = [];
    #speedFilter = [3, 2, 1];
    get speed(){
        if (this.#mode == Bike.MODES.FILTERED){
            return this.#weightedAverage(this.#speedBuffer, this.#speedFilter);
        }
        return this.#speed;
    }

    #cadenceBuffer = [];
    #cadenceFilter = [3, 2, 1];
    get cadence(){
        if (this.#mode == Bike.MODES.FILTERED){
            return this.#weightedAverage(this.#cadenceBuffer, this.#cadenceFilter);
        }
        return this.#cadence;
    }

    #weightedAverage(signal, weights){
        let weightSum = 0;
        let sum = 0;
        for(var i = 0; i < signal.length; i++){
            // Weights are read through in the reverse order to reflect the 'convolution' - notation/method/operation
            let weightIndex = weights.length-1-i;
            let weightIndexInRange = (weightIndex >= 0 && weightIndex < weights.length)
            if (!weightIndexInRange) break; // To be true to the source material: the weight should be set to zero, but this achive the same with less work
            let weight = weights[weightIndex];
            weightSum += weight;
            sum = weight*signal[i];
        }
        return weightSum ? sum/weightSum : 0;
    }


    setMode(mode=Bike.MODES.FILTERED){
        if (
            mode == Bike.MODES.FILTERED ||
            mode == Bike.MODES.RAW
        ){
            this.#mode = mode;
        }
        else{
            console.warn("Was not able to set BLE bike mode");
        }
    }

    get accumulatedEnergy(){ return this.#accumulatedEnergy; }
    get accumulatedDistance(){ return this.#accumulatedDistance; }

    #findPayloadIndex(flag, flagIndex){
        if(flag[flagIndex]){
            //Data (payload) index starts at 4 since data index before is the flag field and power ([0:1]-> flag, [2:3]-> power, [4:]-> ?), and data after is dependant on flag field
            let payloadIndex = 4;
            for(var i = 0; i < flagIndex; i++){
                if(flag[i]){
                    payloadIndex += Bike.FLAG_FIELD[this.keys(Bike.FLAG_FIELD)[i]].fieldSize; 
                }
            }
            return payloadIndex;
        }
        else{
            return null;
        }
    }

    connect(){
        this.#connecting = true;

        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            const serviceUUID = 0x1818;            //Cycling power
            const characteristicUUID = 0x2A63;     //Cycling power measurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => {
                    const index0multiplier = Math.pow(2, 0);
                    const index1multiplier = Math.pow(2, 8);   
                    const index2multiplier = Math.pow(2,16);
                    const index3multiplier = Math.pow(2,32);

                    let now = new Date().getTime();

                    let dt  = 0; // [s]
                    if(this.#notificationTimestamp){
                        dt  = (now - this.#notificationTimestamp)/1000; // ms -> s
                    }
                    if(dt > 3){
                        dt  = 0; //Effect: Asume user has disconnected
                    }

                    let flag = event.target.value.getUint8(0) + event.target.value.getUint8(1)*100; // I know this looks wierd, but this is actually how you get the flag field
                    flag = convertTo16BitArray(flag);

                    //Energy
                    if(flag[Bike.FLAG_FIELD.AccumulatedEnergy.index]){
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD.AccumulatedEnergy.index
                        );
                        
                        let data = event.target.value.getUint8(payloadIndex) + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                        this.#accumulatedEnergy = data; // Given in kJ
                        //console.log(data) 
                    }
                    else if(this.#powerAvailable){
                        // CONSIDER: find a more reliable method
                        this.#accumulatedEnergy += dt*this.#power/1000; // J -> kJ
                    }

                    //Power 
                    this.#powerAvailable = true;
                    let payloadIndex = 2;
                    this.#power = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                    this.#powerBuffer.push(this.#power);
                    while(this.#powerBuffer.length > this.#powerFilter.length) this.#powerBuffer.shift();
                    //Speed & Distance
                    if(flag[Bike.FLAG_FIELD.RevolutionData.index]){
                        this.#speedAvailable = true;
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD.RevolutionData.index
                        );

                        let wheelRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier + event.target.value.getUint8(payloadIndex+2)*index2multiplier + event.target.value.getUint8(payloadIndex+3)*index3multiplier;
                        let wheelTime = event.target.value.getUint8(payloadIndex+4)*index0multiplier + event.target.value.getUint8(payloadIndex+5)*index1multiplier;
                        let prevRevs = this.wheelRevolutionData.prevRevs;
                        let prevTime = this.wheelRevolutionData.prevTime;
                        
                        let configuration = 1; //TODO: get from flag field
                        let rpm = 0;
                        
                        if(!this.wheelRevolutionData.prevStaleness){
                            let dTime = wheelTime - prevTime; //TODO: fix roll over
                            let dRevs = wheelRevs - prevRevs;

                            if(dTime > 0){
                                rpm = (configuration ? 2048 : 1024)*60*dRevs/dTime;
                                if(rpm) this.wheelRevolutionData.nonZeroValue = rpm;  // CONSIDER: Finding a better solution to speed blips
                            }
                        }
                        else{
                            this.wheelRevolutionData.prevStaleness = false;
                        }
                        if(!rpm && this.#power) rpm = this.wheelRevolutionData.nonZeroValue;

                        this.wheelRevolutionData.prevRevs = wheelRevs;
                        this.wheelRevolutionData.prevTime = wheelTime;

                        const wheelRadius = 0.311; // [meters] 700x18c
                        const kmh_rpm = 3/25*Math.PI*wheelRadius;
                        this.#speed = kmh_rpm*rpm;
                        this.#speedBuffer.push(this.#speed);
                        while(this.#speedBuffer.length > this.#speedFilter.length) this.#speedBuffer.shift();
                        this.#accumulatedDistance = wheelRevs*2*Math.PI*wheelRadius;
                    }        

                    //Cadence
                    if(flag[Bike.FLAG_FIELD.CrankRevolutionData.index]){
                        this.#cadenceAvailable = true;
                        let payloadIndex = this.#findPayloadIndex(
                            flag,
                            Bike.FLAG_FIELD.CrankRevolutionData.index
                        );

                        let crankRevs = event.target.value.getUint8(payloadIndex)*index0multiplier + event.target.value.getUint8(payloadIndex+1)*index1multiplier;
                        let crankTime = event.target.value.getUint8(payloadIndex+2)*index0multiplier + event.target.value.getUint8(payloadIndex+3)*index1multiplier;
                        let prevRevs = this.crankRevolutionData.prevRevs;
                        let prevTime = this.crankRevolutionData.prevTime;

                        let rpm = 0;
                        
                        if(!this.crankRevolutionData.prevStaleness){
                            let dTime = crankTime - prevTime;
                            let dRevs = crankRevs - prevRevs;

                            if(dTime > 0 && dRevs >= 0){    //CONSIDER: finding a better solution to roll over / overflows
                                rpm = 1024*60*dRevs/dTime;
                                if(rpm) this.crankRevolutionData.nonZeroValue = rpm;
                            }
                            else{                       
                                rpm = this.#cadence;       //Use old value in case of annomolies in the data
                            }
                        }
                        else{
                            this.crankRevolutionData.prevStaleness = false;
                        }

                        this.crankRevolutionData.prevRevs = crankRevs;
                        this.crankRevolutionData.prevTime = crankTime;
                        this.#cadence = rpm;
                        this.#cadenceBuffer.push(this.#cadence);
                        while(this.#cadenceBuffer.length > this.#cadenceFilter.length) this.#cadenceBuffer.shift();
                    }     

                    this.#notificationTimestamp = now;  
                    //CONSIDER implement other/more features (as seen in Bike.FLAG_FIELD)
                })
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            }); 
        }

        this.#powerAvailable = true;    
        this.#connecting = false; //Not _connecting anymore since we now are fully connected 
    }

    onDisconnected(event){
        this.self = null;
        this.name = null; 

        this.#connecting = false;
        this.#notificationTimestamp = null;

        this.#powerAvailable = false;
        this.#speedAvailable = false;
        this.#cadenceAvailable = false;
        this.#power = 0;
        this.#speed = 0;
        this.#cadence = 0; 
        this.#accumulatedEnergy = 0;
        this.#accumulatedDistance = 0;

        // TODO: make private
        this.wheelRevolutionData.reset();
        this.crankRevolutionData.reset();
    }        
}

class HeartRate {

    #heartRate = null;
    #accumulatedHeartBeats = 0;
    #notificationTimestamp = null;

    constructor(){
        this.self = null;
        this.name = null;        
    }
    get isConnected() { if(this.self){ return true; } return false; }
    get heartRate(){
        return this.#heartRate;
    }
    get accumulatedHeartBeats(){
        return Math.floor(this.#accumulatedHeartBeats);
    }

    connect(){
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = 0x180D;            //Heart Rate UUID
            var characteristicUUID = 0x2A37;     //Heart Rate Masurement
            var options = {
                filters: [
                    { services: [serviceUUID] }
                ],
                optionalServices: [characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name;
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);
                return device.gatt.connect();
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => {
                    let now = new Date().getTime();
                    let dt = (now - this.#notificationTimestamp)/1000; // [s]
                    if (dt > 0 && dt < 6){
                        let beats = dt/60*this.#heartRate;
                        this.#accumulatedHeartBeats += beats;
                    }
                    this.#notificationTimestamp = now;
                    this.#heartRate = event.target.value.getUint8(1); // TODO: Fix -> Max heartrate 255, then rollover
                });        
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
    }
    onDisconnected(event){
        //const device = event.target;
        this.self = null;
        this.name = null;
        this.heartRate = null;
        this.#notificationTimestamp = null;
    }

    resetAccumulator(){
        this.#accumulatedHeartBeats = 0;
    }
    
}

class SRAT {
    #connecting = false;
    constructor(){
        this.self = null;
        this.name = null;        
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    connect(){
        this.#connecting = true;
        if(this.self != null){
            this.self.gatt.disconnect();
        }    
    
        if(bluetooth_available()){
            var serviceUUID = "be30f8d4-4711-11ee-be56-0242ac120002";            //SRAT+ Service
            var characteristicUUID = "be30f8d4-4711-11ee-be56-0242ac120003";     //SRAT+ Output Characteristic
            var options = {
                acceptAllDevices: true,
                // filters: [
                //     { services: [serviceUUID] }
                // ],
                optionalServices: [serviceUUID, characteristicUUID]
            }
            
            navigator.bluetooth.requestDevice(options)
            .then(device => {
                // Connect device
                this.self = device;
                this.name = device.name; 
                device.addEventListener('gattimeStamperverdisconnected', this.onDisconnected);                                  // Set up event listener for when device getimeStamp disconnected.
                return device.gatt.connect();                                                                                   // AttemptTimeStamp to connect to remote GATT Server.
            })
            .then(server => {
                return server.getPrimaryService(serviceUUID);            
            })    
            .then(service => {
                return service.getCharacteristic(characteristicUUID);            
            })    
            .then(characteristic => {
                characteristic.startNotifications();
                characteristic.addEventListener("characteristicvaluechanged", (event) => this.#notifyHandler(event, this));  
                this.#connecting = false; //Not _connecting anymore since we now are fully connected 
            })
            .catch((error) => {
                console.error(`Something went wrong. ${error}`);
                this.onDisconnected();
            });
        }
        else{
            this.#connecting = false;
        }
    }
    onDisconnected(event){
        this.self = null;
        this.name = null;
        this.#connecting = false;
        this.mode = 0;
        this.bts  = [false, false, false, false, false, false];
        this.axis = {a1: 0, a2: 0, roll: 0, pitch: 0, yaw: 0};
    }
    #notifyHandler(event, object){  
        object.mode = event.target.value.getUint8(0) >> 6;
        let tmp = event.target.value.getUint8(0);
        for(var i = 0; i < 6; i++){
            object.bts[i] = (tmp & 0b1) ? true : false;
            tmp = tmp >> 1;
        }
        object.axis.a1 = event.target.value.getUint8(1);
        object.axis.a2 = event.target.value.getUint8(2);
        object.axis.roll = event.target.value.getUint8(3);
        object.axis.pitch = event.target.value.getUint8(4);
        object.axis.yaw = event.target.value.getUint8(5);
    }
}


class SessionData{
    #sample = false;
    #timeStart = 0; // Given in Epoch -> new Date().getTime();
    #timeEnd = 0;   // Given in Epoch -> new Date().getTime(); TODO: Consider removing since it is ambiguous

    #laps = [0];    // Given in dt [s] since timeStart
    #lapIndex = 0;
    
    // Data Matrix
    #hr = [];
    #power = [];
    #cadence = [];
    #speed = [];
    #accumulatedTime = [];
    #accumulatedDistance = [];
    #accumulatedEnergy = [];
    #accumulatedHeartBeats = [];

    // Storing for easy retrieving without searching
    #maxPwr = 0;
    #maxPulse = 0;
    #maxCadance = 0;
    #maxSpeed = 0;
    #lapMaxPwr = 0;
    #lapMaxPulse = 0;
    #lapMaxCadence = 0;
    #lapMaxSpeed = 0;

    // TODO: latitude and lngitude support

    constructor(){
        this.restart();
    }

    static TYPES = Object.freeze({
        LAP: 'lap',
        TOTAL: 'total'
    })

    restart(){
        this.#sample = false;
        this.#timeStart = 0; // Given in Epoch -> new Date().getTime();
        this.#timeEnd = 0;   // Given in Epoch -> new Date().getTime(); TODO: Consider removing since it is ambiguous

        this.#laps = [0];    // Given in dt [s] since timeStart
        this.#lapIndex = 0;
        
        // Data Matrix
        this.#hr = [];
        this.#power = [];
        this.#cadence = [];
        this.#speed = [];
        this.#accumulatedTime = [];
        this.#accumulatedDistance = [];
        this.#accumulatedEnergy = [];
        this.#accumulatedHeartBeats = [];

        // Storing for easy retrieving without searching
        this.#maxPwr = 0;
        this.#maxPulse = 0;
        this.#maxCadance = 0;
        this.#maxSpeed = 0;
        this.#lapMaxPwr = 0;
        this.#lapMaxPulse = 0;
        this.#lapMaxCadence = 0;
        this.#lapMaxSpeed = 0;
    }

    get startTime(){
        return this.#timeStart;
    }
    get endTime(){
        if(this.#timeEnd){
            return this.#timeEnd
        }
    }

    start(){
        if (this.#timeStart != 0) return;
        this.#timeStart = new Date().getTime();
        this.#timeEnd = 0;
        this.#sample = true;
    }
    stop(){
        if (this.#timeEnd != 0) return;
        this.#timeEnd = new Date().getTime();
        this.#sample = false;
    }
    lap(){
        if(this.#timeStart == 0) return;
        let dt = (new Date().getTime() - this.#timeStart)/1000; // [s]
        this.#laps.push(dt);
        this.#lapIndex = this.#power.length-1; // Can be any of the data-arrays as they all should have the same length
        this.#lapMaxPwr = 0;
        this.#lapMaxPulse = 0;
        this.#lapMaxCadence = 0;
        this.#lapMaxSpeed = 0;
    }

    sample(pwr, cadence = null, speed = null, accDist = null, accEnergy = null, hr = null, accHr = null){
        if(!this.#sample) return;
        if(pwr == undefined || pwr == null) return;
        
        let dt = new Date().getTime() - this.timeStart;

        this.#power.push(pwr);
        this.#cadence.push(cadence);
        this.#speed.push(speed);
        this.#accumulatedDistance.push(accDist);
        this.#accumulatedEnergy.push(accEnergy);
        this.#hr.push(hr);
        this.#accumulatedHeartBeats.push(accHr);
        this.#accumulatedTime.push(dt);

        if (pwr && pwr > this.maxPwr) this.maxPwr = pwr;
        if (cadence && cadence > this.maxCadance) this.maxCadance = cadence;
        if (hr && hr > this.maxPulse) this.maxPulse = hr;
        if (speed && speed > this.maxSpeed) this.maxSpeed = speed;

        if (pwr && pwr > this.lapMaxPwr) this.lapMaxPwr = pwr;
        if (cadence && cadence > this.lapMaxCadance) this.lapMaxCadance = cadence;
        if (hr && hr > this.lapMaxPulse) this.lapMaxPulse = hr;
        if (speed && speed > this.lapMaxSpeed) this.lapMaxSpeed = speed;
    }

    //max, average
    getPower(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#power, this.#accumulatedTime, 0, this.#power.lenght-1);
            return {max: this.#maxPwr, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#power, this.#accumulatedTime, this.#lapIndex, this.#power.lenght-1)
            return {max: this.#lapMaxPwr, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getSpeed(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#speed, this.#accumulatedTime, 0, this.#speed.length-1);
            return {max: this.#maxSpeed, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#speed, this.#accumulatedTime, this.#lapIndex, this.#speed.length-1)
            return {max: this.#lapMaxSpeed, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getCadence(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#cadence, this.#accumulatedTime, 0, this.#cadence.length-1);
            return {max: this.#maxCadance, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#cadence, this.#accumulatedTime, this.#lapIndex, this.#cadence.length-1)
            return {max: this.#lapMaxCadence, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }
    getHeartBeats(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#hr, this.#accumulatedTime, 0, this.#hr.length-1);
            return {max: this.#maxPulse, avg: readThrough.sum/readThrough.dt}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#hr, this.#accumulatedTime, this.#lapIndex, this.#hr.length-1)
            return {max: this.#lapMaxPulse, avg: readThrough.sum/readThrough.dt}
        }
        else{
            return null;
        }
    }

    // acc, phr
    getDistance(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#accumulatedDistance, this.#accumulatedTime, 0, this.#accumulatedDistance.length-1);
            let distance = readThrough.end-readThrough.start;
            return {acc: distance, phr: distance/readThrough.dt*3600}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#accumulatedDistance, this.#accumulatedTime, this.#lapIndex, this.#accumulatedDistance.length-1);
            let distance = readThrough.end-readThrough.start;
            return {acc: distance, phr: distance/readThrough.dt*3600}
        }
        else{
            return null;
        }
    }
    getEnergy(type = SessionData.TYPES.TOTAL){
        if(type == SessionData.TYPES.TOTAL){
            let readThrough = this.#readThrough(this.#accumulatedEnergy, this.#accumulatedTime, 0, this.#accumulatedEnergy.length-1);
            let energy = readThrough.end-readThrough.start;
            return {acc: energy, phr: energy/readThrough.dt*3600}
        }
        else if(type == SessionData.TYPES.LAP){
            let readThrough = this.#readThrough(this.#accumulatedEnergy, this.#accumulatedTime, this.#lapIndex, this.#accumulatedEnergy.length-1);
            let energy = readThrough.end-readThrough.start;
            return {acc: energy, phr: energy/readThrough.dt*3600}
        }
        else{
            return null;
        }
    }


    #readThrough(array, timeArray, startIndex, endIndex){
        if(array.length != timeArray.length) return null;
        let start = null;
        let end = null;
        let sum = 0;
        let timeTotal = 0;
        for(var i = startIndex; i <= endIndex; i++){
            let nextIndex = i+1;
            if (nextIndex > endIndex || nextIndex >= timeArray.length) continue;
            let dt = timeArray[nextIndex]
            if (dt <= 0) continue;
            dt = dt > 3 ? 1 : dt; // If the next 
            let value = array[i];
            if (value == null) continue;
            if (start == null && value != null) start = value;
            if (value != null) end = value;
            sum += dt*value;
        }
        start = start == null ? 0 : start;
        end = end == null ? 0 : end;
        timeTotal = timeTotal <= 0 ? 1: timeTotal; // Avoid devide by zero
        return {start: start, end: end, sum: sum, dt: timeTotal};
    }

    getSessionDataAsJSON(asString = false){
        let data = {
            startTime: this.#timeStart,
            endTime: this.#timeEnd,
            laps: this.#laps,
            
            time: this.#accumulatedTime,
            power: this.#power,
            cadence: this.#cadence,
            speed: this.#speed,
            accumulatedDistance: this.#accumulatedDistance,
            accumulatedEnergy: this.#accumulatedEnergy,
            heartRate: this.#hr
        }
        if (asString) return JSON.stringify(data);
        return data;
    }
}

class UI{
    #ui = document.createElement("div");
    constructor(){
        // TODO: oh holy shit fuck!! (dom with logic, graphics and css integrated)
    }

    get domEl(){
        return this.#ui;
    }
}

class Session{
    #sample = false;
    #lastSampleTimestamp = {bike: null, hr: null};
    #started = false;
    #ended = false;

    constructor(){
        this.bike = new Bike();
        this.bike.setMode(Bike.MODES.FILTERED);
        this.hr = new HeartRate();
        this.steeringWheel = new SRAT();
        this.sessionData = new SessionData();
        // this.ui = new UI(); // TODO

        this.sampleRateMS = 490; // From nyquist sampling theorem -> the frequency we are measuring is promissed at 1 pr. second. We should then sample check wheter or not to store the current signal 2 times that frequency so that we do not miss out on any one data-point. By setting it 10 ms before we are conservative.
        this.#sampleLoop(true);
    }

    get epochStartTime(){
        return this.sessionData.startTime;
    }
    get started(){
        return this.#started;
    }
    get ended(){
        return this.#ended;
    }
    get paused(){
        return this.#started && !this.#sample && !this.#ended;
    }

    new(){
        this.sessionData = new SessionData();
        this.#started = false;
        this.#ended = false;
    }

    start(){
        if(!bluetooth_available()) {
            alert("Bluetooth module initiated, however, your browser do not support bluetooth! [Consider changing to chrome]");
            return;
        }
        this.sessionData.start();
        this.#sample = true;
        this.#started = true;
    }
    pause(){
        this.#sample = false;
    }
    lap(){
        this.sessionData.lap();
    }
    resume(){
        if(this.#started){
            this.#sample = true;
        }
    }
    stop(){
        this.sessionData.stop();
        this.#sample = false;
        this.#ended = true;
    }
    getStats(){
        let current = {
            power: this.bike.power,
            speed: this.bike.speed,
            cadence: this.bike.cadence,
            heartRate: this.hr.heartRate
        }
        let power = this.sessionData.getPower(SessionData.TYPES.LAP);
        let speed = this.sessionData.getSpeed(SessionData.TYPES.LAP);
        let cadence = this.sessionData.getCadence(SessionData.TYPES.LAP);
        let heartRate = this.sessionData.getHeartBeats(SessionData.TYPES.LAP);
        let distance = this.sessionData.getDistance(SessionData.TYPES.LAP);
        let energy = this.sessionData.getEnergy(SessionData.TYPES.LAP);
        let lap = {
            power: { max: power.max, avg: power.avg },
            speed: { max: speed.max, avg: speed.avg },        
            cadence: { max: cadence.max, avg: cadence.avg },  
            heartRate: { max: heartRate.max, avg: heartRate.avg },
            distance: { acc: distance.acc, phr: distance.phr },
            energy: { acc: energy.acc, phr: energy.phr }
        };
        power = this.sessionData.getPower(SessionData.TYPES.TOTAL);
        speed = this.sessionData.getSpeed(SessionData.TYPES.TOTAL);
        cadence = this.sessionData.getCadence(SessionData.TYPES.TOTAL);
        heartRate = this.sessionData.getHeartBeats(SessionData.TYPES.TOTAL);
        distance = this.sessionData.getDistance(SessionData.TYPES.TOTAL);
        energy = this.sessionData.getEnergy(SessionData.TYPES.TOTAL);
        let total = {
            power: { max: power.max, avg: power.avg },
            speed: { max: speed.max, avg: speed.avg },        
            cadence: { max: cadence.max, avg: cadence.avg },  
            heartRate: { max: heartRate.max, avg: heartRate.avg },
            distance: { acc: distance.acc, phr: distance.phr },
            energy: { acc: energy.acc, phr: energy.phr }
        }
        return {startTime: this.sessionData.startTime, endTime: this.sessionData.endTime, total: total, lap: lap, current: current};
    }

    #sampleLoop(loop = false){
        if (loop) {
            setTimeout(() => this.#sampleLoop(), this.sampleRateMS);
        }
        if (!this.#sample){
            return;
        }        
        
        let now = new Date().getTime();

        let hr = null;
        let accHr = null;

        if(this.hr.self != null){
            hr = this.hr.heartRate;
            accHr = this.hr.accumulatedHeartBeats;

        }

        if(this.bike.self != null && this.bike.timestamp != this.#lastSampleTimestamp.bike){
            this.sessionData.sample(
                this.bike.power,
                this.bike.cadence,
                this.bike.speed,
                this.bike.accumulatedDistance,
                this.bike.accumulatedEnergy,
                hr,
                accHr
            );
            this.#lastSampleTimestamp.bike = this.bike.timestamp;
        }     
        
        const WatchDogTimeout = {bike: 60*1000, hr: 6*1000}
        if (this.bike.timestamp && now > this.bike.timestamp + WatchDogTimeout.bike) this.bike.onDisconnected();
        if (this.hr.timestamp && now > this.hr.timestamp + WatchDogTimeout.hr) this.hr.onDisconnected();
    }
}



//////////////////////////////
///    Helper functions    ///
//////////////////////////////

function convertTo16BitArray(x){
    // index 0 is LSB 
    if ( x < 0  || x >= Math.pow(2, 16)) { return []; }
    let returnArray = []
    for(let i = 15; i >= 0; i--){
        let dec = Math.pow(2, i);
        if(dec <= x){
            x -= dec;
            returnArray.unshift(1);
        }
        else{
            returnArray.unshift(0);
        }
    }
    return returnArray;
}

function Joule2Cal(joules){
    return 0.2390057361*joules;
}

function formatTime(ms, displayMS = false){
    var isNegative = ms < 0;
    ms = Math.abs(ms);
    let h = 60*60*1000;
    let m = 60*1000;
    let s = 1000;
    var hours = Math.floor(ms/h);
    ms -= hours*h;
    var minutes = Math.floor(ms/m);
    ms -= minutes*m;
    var seconds = Math.floor(ms/s);
    ms -= seconds*s;
    if (hours < 10) hours = "0"+hours;
    if (minutes < 10) minutes = "0"+minutes;
    if (seconds < 10) seconds = "0"+seconds;
    
    let time = (isNegative?"- ":"")+hours+":"+minutes+":"+seconds;
    if (displayMS) {
        if (ms < 10){
            ms = "00"+ms;
        } 
        else if(ms < 100){
            ms = "0"+ms;
        }
        else{
            ms = ""+ms;
        }
        time += "."+ms[0]+ms[1];
    }
    return time;
}

function findClosestIndex(timeArray, timestamp){
    let i = 0;
    for(i = 0; i < timeArray.length; i++){
        if(timeArray[i] == timestamp) return i;
        if(timeArray[i] > timestamp) return Math.abs(timeArray[i-1] - timestamp) < Math.abs(timeArray[i][1] - timestamp) ? i-1 : i;
    }
    return i;
}

// function readThrough(dataArray, timeArray, startIndex = 0, endIndex = undefined, tolerance = 3){
//     // TODO
//     return {
//         start: '',
//         end: '',
//         max: '',
//         weightedSum: '',
//         time: {work: '', elapsed: ''}
//     };
// }

function bluetooth_available(){
    return navigator.bluetooth;
}

function convertTimestampToISOString(timestamp) {
    const date = new Date(timestamp); // Create a Date object from the timestamp
    const isoString = date.toISOString(); // Get the ISO string (e.g., '2023-10-15T12:00:00.000Z')
    return isoString.slice(0, 19) + 'Z'; // Remove milliseconds and return the formatted string
}

function convertTimestampToHMDhhmmString(timestamp){
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Months are 0-based
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${year}_${month}_${day}_${hours}${minutes}`;
}

function downloadTCX(sessionData){
    if (!(sessionData instanceof SessionData)) {
        throw new Error(`Expected an instance of ${sessionData.name}, but received ${sessionData.constructor.name}`);
    }

    const dataMatrix = sessionData.getSessionDataAsJSON();
    
    if(!dataMatrix.startTime){
        alert("It does not seem like this session was ever started. Can not download a session that has not been completed.");
        return false;
    }
    if(!dataMatrix.endTime){
        alert("It does not seem like this session was ever ended. Can not download a session that has not ended.");
        return false;
    }
    if(!dataMatrix.time.length) {
        alert("Did not find any data in the session. Download Canceled.");
        return false;
    }
    
    // START A TCX FILE CONTAINING THE SESSION
    let tcxData = `<?xml version="1.0" encoding="UTF-8"?>
    <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Activities>
            <Activity Sport="Biking">
                <Id>`+convertTimestampToISOString(dataMatrix.timeStart)+`</Id>`;
    
    // LOOP OVER ALL LAPS
    let trackpointIndex = 0; // Global index of all the sample points
    for(var i = 0; i < dataMatrix.laps.length; i++){
        const dtStart = dataMatrix.laps[i]; // [ms]
        const dtEnd = i < dataMatrix.laps.length-1 ? Math.floor(dataMatrix.laps[i+1]*1000) : dataMatrix.timeEnd - dataMatrix.timeStart; // [ms]
        
        const startTime = dataMatrix.timeStart + dtStart;
        const endTime = (i < dataMatrix.laps.length-1) ? startTime+Math.floor(dataMatrix.laps[i+1]*1000) : dataMatrix.timeEnd;    
        const lapTimeSeconds = Math.round((endTime - startTime)/1000); // [s]

        const startIndex = trackpointIndex;
        const endIndex = i < dataMatrix.laps.length-1 ? findClosestIndex(dataMatrix.time, (dtEnd/1000)): dataMatrix.time.length-1;

        const startDistance = dataMatrix.accumulatedDistance[startIndex];
        const endDistance = dataMatrix.accumulatedDistance[endIndex];
        const distance = Math.round((endDistance-startDistance));

        const startEnergy = dataMatrix.accumulatedEnergy[startIndex];
        const endEnergy = dataMatrix.accumulatedEnergy[endIndex];

        const calories = Math.round(Joule2Cal(endEnergy-startEnergy)); // [kJoule] -> [kCal] convertion

        // START A LAP CONSISTING OF A TRACK
        let lap = `<Lap StartTime="`+convertTimestampToISOString(startTime)+`">
                    <TotalTimeSeconds>`+lapTimeSeconds+`</TotalTimeSeconds>
                    <DistanceMeters>`+distance+`</DistanceMeters>
                    <Calories>`+calories+`</Calories>
                    <Track>`;

        // ADD ALL TRACK POINTS IN THE LAP
        let dt = Math.floor(dataMatrix.time[trackpointIndex]*1000); // [s] -> [ms] convertion
        while(dt <= dtEnd){            
            let trackpoint = `<Trackpoint>
                <Time>`+convertTimestampToISOString(startTime+dt)+`</Time>`;
            
            // CONSIDER implementing: <AltitudeMeters>, <Position>-><LatitudeDegrees><LongitudeDegrees>

            if(dataMatrix.hr[trackpointIndex] != null){
                trackpoint += `<HeartRateBpm>`+Math.round(dataMatrix.hr[trackpointIndex])+`</HeartRateBpm>`;
            }
            if(dataMatrix.accumulatedDistance[trackpointIndex] != null){
                let trpt_distance = Math.floor((dataMatrix.accumulatedDistance[trackpointIndex]-startDistance));
                trackpoint += `<DistanceMeters>`+trpt_distance+`</DistanceMeters>`;
            }
            if(dataMatrix.cadence[trackpointIndex] != null){
                trackpoint += `<Cadence>`+Math.round(dataMatrix.cadence[trackpointIndex])+`</Cadence>`;
            }
            if(dataMatrix.power[trackpointIndex] != null){
                trackpoint += `<Watts>`+Math.round(dataMatrix.power[trackpointIndex])+`</Watts>`;
            }
            
            trackpoint += `</Trackpoint>`;
            lap += trackpoint;

            // Iterate
            trackpointIndex++;            
            if(trackpointIndex >= dataMatrix.time.length) {
                console.error("Download data corrupted");
                break; // Something has gone terrible wrong at this point (Should, however, never happen. And we can be certain since sessionData is asserted to type SessionData, where the sample technique is 'protected')
            }
            dt = Math.floor(dataMatrix.time[trackpointIndex]*1000);            
        }

        // END OF LAP
        lap += `</Track></Lap>`;
        // ADD LAP TO SESSION
        tcxData += lap;
    }
    // END OF SESSION
    tcxData += `</Activity></Activities></TrainingCenterDatabase>`;
    
    const blob = new Blob([tcxData], { type: 'application/xml' });
    // Create a download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = convertTimestampToHMDhhmmString(dataMatrix.startTime)+'_activity.tcx'; // File name (TODO: add date)
    document.body.appendChild(a);
    a.click();

    // Cleanup
    window.URL.revokeObjectURL(url);
    return true;
}

export {Session, SessionData, Bike, HeartRate, downloadTCX, Joule2Cal, formatTime, bluetooth_available} // {SRAT}