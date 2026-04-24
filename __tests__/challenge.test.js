const DeepSeekHash = require('../src/challenge');

describe('DeepSeekHash', () => {
  let hash;

  beforeEach(() => {
    hash = new DeepSeekHash();
  });

  describe('constructor', () => {
    test('should initialize with default values', () => {
      expect(hash.wasmInstance).toBeNull();
      expect(hash.offset).toBe(0);
      expect(hash.cachedUint8Memory).toBeNull();
      expect(hash.cachedTextEncoder).toBeDefined();
    });
  });

  describe('getCachedUint8Memory', () => {
    test('should return cached memory when available', () => {
      const mockMemory = new Uint8Array(1024);
      hash.wasmInstance = { memory: { buffer: mockMemory.buffer } };
      hash.cachedUint8Memory = mockMemory;
      
      const result = hash.getCachedUint8Memory();
      expect(result).toBe(mockMemory);
    });

    test('should create new memory when cached is null', () => {
      const mockBuffer = new ArrayBuffer(1024);
      hash.wasmInstance = { memory: { buffer: mockBuffer } };
      
      const result = hash.getCachedUint8Memory();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.buffer).toBe(mockBuffer);
    });

    test('should create new memory when cached has zero byteLength', () => {
      const mockBuffer = new ArrayBuffer(1024);
      hash.wasmInstance = { memory: { buffer: mockBuffer } };
      hash.cachedUint8Memory = new Uint8Array(0);
      
      const result = hash.getCachedUint8Memory();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.buffer).toBe(mockBuffer);
    });
  });

  describe('encodeString', () => {
    test('should encode ASCII string without reallocate', () => {
      const mockMemory = new Uint8Array(1024);
      const mockAllocate = jest.fn().mockReturnValue(100);
      hash.wasmInstance = { memory: { buffer: mockMemory.buffer } };
      hash.cachedUint8Memory = mockMemory;

      const result = hash.encodeString('hello', mockAllocate, null);
      
      expect(mockAllocate).toHaveBeenCalledWith(5, 1);
      expect(result).toBe(100);
      expect(hash.offset).toBe(5);
    });

    test('should encode string with reallocate for non-ASCII', () => {
      const mockMemory = new Uint8Array(1024);
      const mockAllocate = jest.fn().mockReturnValue(100);
      const mockReallocate = jest.fn().mockReturnValue(200);
      hash.wasmInstance = { memory: { buffer: mockMemory.buffer } };
      hash.cachedUint8Memory = mockMemory;

      const result = hash.encodeString('héllo', mockAllocate, mockReallocate);
      
      expect(mockAllocate).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    test('should handle pure ASCII string with reallocate', () => {
      const mockMemory = new Uint8Array(1024);
      const mockAllocate = jest.fn().mockReturnValue(100);
      const mockReallocate = jest.fn().mockReturnValue(100);
      hash.wasmInstance = { memory: { buffer: mockMemory.buffer } };
      hash.cachedUint8Memory = mockMemory;

      const result = hash.encodeString('hello', mockAllocate, mockReallocate);
      
      expect(mockAllocate).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('calculateHash', () => {
    test('should throw error for unsupported algorithm', () => {
      hash.wasmInstance = {};
      
      expect(() => {
        hash.calculateHash('UnsupportedAlgo', 'challenge', 'salt', 1000, 1234567890);
      }).toThrow('Unsupported algorithm: UnsupportedAlgo');
    });

    test('should return undefined when status is 0', () => {
      const mockMemory = new ArrayBuffer(1024);
      const dataView = new DataView(mockMemory);
      dataView.setInt32(0, 0, true);
      
      hash.wasmInstance = {
        memory: { buffer: mockMemory },
        __wbindgen_add_to_stack_pointer: jest.fn().mockReturnValue(0),
        __wbindgen_export_0: jest.fn().mockReturnValue(100),
        __wbindgen_export_1: null,
        wasm_solve: jest.fn()
      };
      hash.cachedUint8Memory = new Uint8Array(mockMemory);

      const result = hash.calculateHash('DeepSeekHashV1', 'challenge', 'salt', 1000, 1234567890);
      
      expect(result).toBeUndefined();
    });

    test('should return value when status is not 0', () => {
      const mockMemory = new ArrayBuffer(1024);
      const dataView = new DataView(mockMemory);
      dataView.setInt32(0, 1, true);
      dataView.setFloat64(8, 12345.678, true);
      
      hash.wasmInstance = {
        memory: { buffer: mockMemory },
        __wbindgen_add_to_stack_pointer: jest.fn().mockReturnValue(0),
        __wbindgen_export_0: jest.fn().mockReturnValue(100),
        __wbindgen_export_1: null,
        wasm_solve: jest.fn()
      };
      hash.cachedUint8Memory = new Uint8Array(mockMemory);

      const result = hash.calculateHash('DeepSeekHashV1', 'challenge', 'salt', 1000, 1234567890);
      
      expect(result).toBe(12345.678);
    });
  });

  describe('init', () => {
    test('should initialize WASM instance', async () => {
      const mockExports = { 
        memory: { buffer: new ArrayBuffer(1024) },
        wasm_solve: jest.fn()
      };
      
      // Mock fs.readFileSync
      const originalReadFileSync = require('fs').readFileSync;
      require('fs').readFileSync = jest.fn().mockReturnValue(Buffer.from('mock wasm'));
      
      // Mock WebAssembly.instantiate
      const originalInstantiate = global.WebAssembly.instantiate;
      global.WebAssembly.instantiate = jest.fn().mockResolvedValue({
        instance: { exports: mockExports }
      });

      const result = await hash.init('test.wasm');
      
      expect(result).toBe(mockExports);
      expect(hash.wasmInstance).toBe(mockExports);

      global.WebAssembly.instantiate = originalInstantiate;
      require('fs').readFileSync = originalReadFileSync;
    });
  });
});
